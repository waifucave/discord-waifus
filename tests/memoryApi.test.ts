import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { conversationLedgerPath } from "../src/orchestration/context/keys.js";
import { markMemoriesRetrieved, readMemoryStore } from "../src/orchestration/stores/memories.js";
import { ConversationLedgerSchema, type LedgerEntry } from "../src/shared/schemas/context.js";
import { MemoryStoreSchema, PendingObservationsFileSchema, createEmptyRevisionedFile, type MemoryRecord } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const KEVIN_ID = "100000000000000001";
const MIA_ID = "100000000000000002";
const T = "2026-10-01T12:00:00.000Z";

async function makeApp() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: T,
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({ dataRoot: root, runtime, storage });
  apps.push(app);
  return { app, storage };
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    waifuId: "yuki",
    content: `Memory ${id}`,
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: {},
    subjects: [],
    revision: 0,
    createdAt: T,
    updatedAt: T,
    status: "active",
    ...overrides
  };
}

async function seed(storage: StorageService, memories: MemoryRecord[]) {
  await storage.writeJson("memories:global", "user/memories.json", MemoryStoreSchema, MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories })));
}

describe("memory API (global memory)", () => {
  it("filters by provenance: guildId, origin=dm, subjectUserId", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [
      record("a", { origin: { guildId: "g1", channelId: "c1" }, subjects: [{ discordUserId: KEVIN_ID, name: "Kevin" }] }),
      record("b", { origin: { guildId: "g2" } }),
      record("c", { origin: { dm: true }, subjects: [{ discordUserId: MIA_ID, name: "Mia" }] })
    ]);
    const ids = async (query: string) =>
      (JSON.parse((await app.inject({ method: "GET", url: `/api/memories?${query}` })).body) as { memories: MemoryRecord[] }).memories.map((m) => m.id);
    expect(await ids("guildId=g1")).toEqual(["a"]);
    expect(await ids("origin=dm")).toEqual(["c"]);
    expect(await ids(`subjectUserId=${KEVIN_ID}`)).toEqual(["a"]);
    expect(await ids("waifuId=yuki")).toEqual(["a", "b", "c"]);
  });

  it("POST takes optional guildId → origin and subjects, and reports duplicates without blocking", async () => {
    const { app } = await makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { waifuId: "yuki", content: "Kevin is allergic to peanuts.", subjects: [{ discordUserId: KEVIN_ID, name: "Kevin" }] }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).not.toHaveProperty("duplicateOf");
    const original = first.json().memories[0];
    expect(original).toMatchObject({ origin: {}, pinned: true, source: "user", revision: 0 });

    const dup = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { waifuId: "yuki", guildId: "g1", channelId: "c1", content: "kevin is allergic to peanuts", subjects: [{ discordUserId: KEVIN_ID, name: "Kevin" }] }
    });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().duplicateOf).toBe(original.id);
    expect(dup.json().memories).toHaveLength(2);
    expect(dup.json().memories[1].origin).toEqual({ guildId: "g1", channelId: "c1" });
  });

  it("per-record revision: edits to different records with the same stale store revision both succeed", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [record("a"), record("b")]);
    const a = await app.inject({ method: "PUT", url: "/api/memories/a", payload: { recordRevision: 0, content: "A edited" } });
    const b = await app.inject({ method: "PUT", url: "/api/memories/b", payload: { recordRevision: 0, content: "B edited" } });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const store = await readMemoryStore(storage);
    expect(store.memories.map((m) => [m.id, m.content, m.revision])).toEqual([["a", "A edited", 1], ["b", "B edited", 1]]);
  });

  it("same record with a stale recordRevision → 409 carrying the record; missing revision → 428", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [record("a")]);
    expect((await app.inject({ method: "PUT", url: "/api/memories/a", payload: { recordRevision: 0, content: "first" } })).statusCode).toBe(200);
    const stale = await app.inject({ method: "PUT", url: "/api/memories/a", payload: { recordRevision: 0, content: "second" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "Conflict", latest: { revision: expect.any(Number) }, record: { id: "a", revision: 1, content: "first" } });
    const legacyStale = await app.inject({ method: "PUT", url: "/api/memories/a", payload: { revision: 0, content: "x" } });
    expect(legacyStale.statusCode).toBe(409);
    expect(legacyStale.json().record).toMatchObject({ id: "a", revision: 1 });
    const missing = await app.inject({ method: "PUT", url: "/api/memories/a", payload: { content: "x" } });
    expect(missing.statusCode).toBe(428);
    const deleteStale = await app.inject({ method: "DELETE", url: "/api/memories/a", payload: { recordRevision: 0 } });
    expect(deleteStale.statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: "/api/memories/a", payload: { recordRevision: 1 } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().memories).toEqual([]);
  });

  it("archive by the user records the reason; restore clears it", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [record("a", { status: "archived", archivedReason: "merged", mergedInto: "b" }), record("b")]);
    const restored = await app.inject({ method: "PUT", url: "/api/memories/a", payload: { recordRevision: 0, status: "active" } });
    const a = restored.json().memories[0];
    expect(a).toMatchObject({ status: "active", revision: 1 });
    expect(a).not.toHaveProperty("archivedReason");
    expect(a).not.toHaveProperty("mergedInto");
    const archived = await app.inject({ method: "PUT", url: "/api/memories/b", payload: { recordRevision: 0, status: "archived" } });
    expect(archived.json().memories[1]).toMatchObject({ status: "archived", archivedReason: "user" });
  });

  it("retrieval stamps (lastRetrievedAt) never bump the record revision", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [record("a")]);
    await markMemoriesRetrieved(storage, ["a"], new Date("2026-10-02T00:00:00.000Z"));
    const stamped = (await readMemoryStore(storage)).memories[0]!;
    expect(stamped).toMatchObject({ lastRetrievedAt: "2026-10-02T00:00:00.000Z", revision: 0 });
    // A client holding revision 0 still edits successfully.
    expect((await app.inject({ method: "PUT", url: "/api/memories/a", payload: { recordRevision: 0, content: "ok" } })).statusCode).toBe(200);
    // Within the hour nothing is written at all.
    const before = (await readMemoryStore(storage)).revision;
    await markMemoriesRetrieved(storage, ["a"], new Date("2026-10-02T00:30:00.000Z"));
    expect((await readMemoryStore(storage)).revision).toBe(before);
  });
});

describe("POST /api/memories/forget-user", () => {
  function ledgerEntry(id: string, seq: number, authorId: string, body: string): LedgerEntry {
    return { id, seq, authorId, authorName: authorId === KEVIN_ID ? "Kevin" : "Mia", authorIsBot: false, at: T, kind: "default", body, images: [], state: "live", sealed: false };
  }

  it("dry run counts; then deletes memories, observations and redacts ledger bodies", async () => {
    const { app, storage } = await makeApp();
    await seed(storage, [
      record("kevin", { subjects: [{ discordUserId: KEVIN_ID, name: "Kevin" }] }),
      record("both", { subjects: [{ discordUserId: MIA_ID, name: "Mia" }, { discordUserId: KEVIN_ID, name: "Kevin" }] }),
      record("mia", { subjects: [{ discordUserId: MIA_ID, name: "Mia" }] })
    ]);
    await storage.writeJson("memory:pending", "user/memory/pending-observations.json", PendingObservationsFileSchema, PendingObservationsFileSchema.parse(createEmptyRevisionedFile({
      observations: [
        { id: "o1", waifuId: "yuki", content: "Kevin likes tea", kind: "preference", importance: 2, subjects: [{ discordUserId: KEVIN_ID, name: "Kevin" }], origin: {}, createdAt: T },
        { id: "o2", waifuId: "yuki", content: "Mia likes tea", kind: "preference", importance: 2, subjects: [{ discordUserId: MIA_ID, name: "Mia" }], origin: {}, createdAt: T }
      ]
    })));
    const key = "g_200000000000000001_300000000000000001" as never;
    await storage.writeJson(`ledger:${key}`, conversationLedgerPath(key), ConversationLedgerSchema, ConversationLedgerSchema.parse(createEmptyRevisionedFile({
      conversationKey: key,
      nextSeq: 3,
      entries: {
        e1: ledgerEntry("e1", 1, KEVIN_ID, "my address is 1 Main St"),
        e2: ledgerEntry("e2", 2, MIA_ID, "hi Kevin")
      },
      events: []
    })));

    const invalid = await app.inject({ method: "POST", url: "/api/memories/forget-user", payload: { discordUserId: KEVIN_ID } });
    expect(invalid.statusCode).toBe(400);
    const badId = await app.inject({ method: "POST", url: "/api/memories/forget-user", payload: { discordUserId: "../x", confirm: true } });
    expect(badId.statusCode).toBe(400);

    const dry = await app.inject({ method: "POST", url: "/api/memories/forget-user", payload: { discordUserId: KEVIN_ID, confirm: true, dryRun: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({ discordUserId: KEVIN_ID, dryRun: true, memories: 2, observations: 1, ledgers: 1, ledgerEntries: 1, dmContexts: 0, dmStates: 0, dmLimits: 0, cachedImages: 0 });
    expect((await readMemoryStore(storage)).memories).toHaveLength(3);

    const done = await app.inject({ method: "POST", url: "/api/memories/forget-user", payload: { discordUserId: KEVIN_ID, confirm: true } });
    expect(done.json()).toEqual({ discordUserId: KEVIN_ID, dryRun: false, memories: 2, observations: 1, ledgers: 1, ledgerEntries: 1, dmContexts: 0, dmStates: 0, dmLimits: 0, cachedImages: 0 });
    expect((await readMemoryStore(storage)).memories.map((m) => m.id)).toEqual(["mia"]);
    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema);
    expect(pending.observations.map((o) => o.id)).toEqual(["o2"]);
    const ledger = await storage.readJson(conversationLedgerPath(key), ConversationLedgerSchema);
    expect(ledger.entries.e1!.body).toBe("(removed)");
    expect(ledger.entries.e2!.body).toBe("hi Kevin");

    const again = await app.inject({ method: "POST", url: "/api/memories/forget-user", payload: { discordUserId: KEVIN_ID, confirm: true, dryRun: true } });
    expect(again.json()).toMatchObject({ memories: 0, observations: 0, ledgers: 0, ledgerEntries: 0 });
  });
});
