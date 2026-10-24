// DM deletion scopes (spec 9.1.4), the DM /forget command (9.1.5, O3) and the /api/dms routes
// (9.8): manifest, id validation, listing without message bodies, forget with audit.

import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { readDmLimit, readDmState } from "../src/orchestration/dm/dmStore.js";
import { forgetUser } from "../src/orchestration/memoryForget.js";
import { readMemoryStore, recordWaifuNotes, updatePendingObservations } from "../src/orchestration/stores/memories.js";
import { AuditStore } from "../src/storage/auditStore.js";
import type { StorageService } from "../src/storage/storageService.js";
import { DmDiscord, ScriptedPipeline, USER, dmRoot, dmRuntime, seedDmWorld } from "./dmFixtures.js";
import { removeTempRoot } from "./testUtils.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const KEY = conversationKey({ kind: "dm", waifuId: "aria", userId: USER });
const exists = (file: string) => access(file).then(() => true, () => false);

/** One answered DM (conversation, state, one rate-limit stamp), plus her memories about the user. */
async function world() {
  const { root, storage } = await dmRoot(roots);
  await seedDmWorld(storage);
  const discord = new DmDiscord();
  const runtime = dmRuntime(storage, discord, new ScriptedPipeline());
  await runtime.handleDirectMessage(discord.dm("hi"));
  await recordWaifuNotes(storage, { waifuId: "aria", entries: ["Kevin likes tea"], origin: { dm: true }, subjects: [{ discordUserId: USER, name: "Kevin" }] });
  await recordWaifuNotes(storage, { waifuId: "mina", entries: ["Kevin plays chess"], origin: { guildId: "1" }, subjects: [{ discordUserId: USER, name: "Kevin" }] });
  await updatePendingObservations(storage, (current) => ({
    ...current,
    observations: [
      { id: "o1", waifuId: "aria", content: "Kevin is tired", kind: "context", importance: 2, subjects: [{ discordUserId: USER, name: "Kevin" }], origin: { dm: true }, createdAt: new Date().toISOString() },
      { id: "o2", waifuId: "mina", content: "Kevin won", kind: "context", importance: 2, subjects: [{ discordUserId: USER, name: "Kevin" }], origin: {}, createdAt: new Date().toISOString() }
    ]
  }));
  return { root, storage, discord, runtime };
}

describe("dmForget scopes", () => {
  it("conversation: deletes the transcript and run records, keeps state, memories and the limiter", async () => {
    const { root, storage, runtime } = await world();
    const dry = await dmForget(storage, { userId: USER, waifuId: "aria", scope: "conversation", dryRun: true });
    expect(dry.deleted).toMatchObject({ dmContexts: 1, recentRuns: 1, dmStates: 0, memories: 0 });
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(true);

    const done = await runtime.forgetDm({ userId: USER, waifuId: "aria", scope: "conversation" });
    expect(done.deleted).toMatchObject({ dmContexts: 1, recentRuns: 1 });
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns).toEqual([]);
    expect(state?.lastInboundMessageId).toBeDefined();
    expect((await readMemoryStore(storage)).memories).toHaveLength(2);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("all: also deletes the state, her memories and observations about the user; other waifus and the limiter stay", async () => {
    const { root, storage, runtime } = await world();
    const purged: string[][] = [];
    const done = await dmForget(storage, { userId: USER, waifuId: "aria", scope: "all" }, { purgeImages: async (keys) => void purged.push(keys) });
    expect(done.deleted).toMatchObject({ dmContexts: 1, dmStates: 1, memories: 1, observations: 1 });
    expect(await exists(path.join(root, "user", "dms", USER, "aria.json"))).toBe(false);
    expect(await exists(path.join(root, "user", "dms", USER, "limits", "aria.json"))).toBe(true);
    expect((await readMemoryStore(storage)).memories.map((m) => m.waifuId)).toEqual(["mina"]);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("the owner's forget-user removes every DM file of the user, counters included (the floor stays)", async () => {
    const { root, storage, runtime } = await world();
    const dry = await forgetUser(storage, { discordUserId: USER, dryRun: true });
    expect(dry).toMatchObject({ dmContexts: 1, dmStates: 1, dmLimits: 1, memories: 2, observations: 2 });
    const done = await runtime.forgetUser({ discordUserId: USER });
    expect(done).toMatchObject({ dmContexts: 1, dmStates: 1, dmLimits: 1, memories: 2, observations: 2 });
    // Counters and state are gone; only the forget floor is written back.
    expect(await exists(path.join(root, "user", "dms", USER, "aria.json"))).toBe(false);
    const limits = await readDmLimit(storage, USER, "aria");
    expect(limits.replyTimestamps).toEqual([]);
    expect(limits.floorMessageId).toBeDefined();
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    expect((await readMemoryStore(storage)).memories).toEqual([]);
    await runtime.stop();
  });

  it("the DM /forget command forgets for that waifu and user only and never resets the limiter", async () => {
    const { root, storage, runtime } = await world();
    expect(await runtime.handleDmForgetCommand({ waifuId: "aria", botId: "aria-bot", userId: USER, scope: "conversation" })).toMatch(/forgot our private chat/);
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    expect(await readDmState(storage, USER, "aria")).toBeDefined();
    expect(await runtime.handleDmForgetCommand({ waifuId: "aria", botId: "aria-bot", userId: USER, scope: "everything" })).toMatch(/everything/);
    expect(await readDmState(storage, USER, "aria")).toBeUndefined();
    expect((await readMemoryStore(storage)).memories.map((m) => m.waifuId)).toEqual(["mina"]);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });
});

async function api(storage: StorageService, root: string) {
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const auditStore = new AuditStore(root, { storage });
  const app = await createApiServer({ dataRoot: root, runtime, storage, administration: { auditStore } });
  apps.push(app);
  return { app, auditStore };
}

describe("/api/dms", () => {
  it("is in the route policy manifest with the spec policies", () => {
    const find = (method: string, route: string) => ROUTE_POLICY_MANIFEST.find((entry) => entry.method === method && entry.path === route);
    expect(find("GET", "/api/dms")).toBeDefined();
    expect(find("GET", "/api/dms/:waifuId/:userId")).toBeDefined();
    expect(find("POST", "/api/dms/:waifuId/:userId/forget")).toMatchObject({ auditAction: "dm.forget", retryClass: "transactional" });
  });

  it("lists and shows DMs without message bodies, validates ids, and forgets with an audit record", async () => {
    const { root, storage, runtime } = await world();
    await runtime.stop();
    const { app, auditStore } = await api(storage, root);

    const list = await app.inject({ method: "GET", url: "/api/dms" });
    expect(list.statusCode, list.body).toBe(200);
    const [conversation] = list.json().conversations;
    expect(conversation).toMatchObject({
      conversationKey: KEY,
      waifuId: "aria",
      userId: USER,
      userDisplayName: "Kevin",
      rateLimit: { used: 1, max: 30, windowMinutes: 60, limited: false },
      lastRun: { status: "sent" },
      context: { epoch: 0 }
    });
    expect(list.body).not.toContain("\"hi\"");
    expect((await app.inject({ method: "GET", url: "/api/dms?waifuId=mina" })).json().conversations).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/dms?limit=500" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dms?userId=kevin" })).statusCode).toBe(400);

    const show = await app.inject({ method: "GET", url: `/api/dms/aria/${USER}` });
    expect(show.json()).toMatchObject({ state: { waifuId: "aria", userId: USER }, rateLimit: { used: 1 } });
    expect((await app.inject({ method: "GET", url: `/api/dms/mina/${USER}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/dms/bad%24id/${USER}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/dms/.../${USER}/forget`, payload: { confirm: true, scope: "all" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dms/aria/not-a-snowflake" })).statusCode).toBe(400);

    const noConfirm = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { scope: "all" } });
    expect(noConfirm.statusCode).toBe(400);
    const dry = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { confirm: true, scope: "all", dryRun: true } });
    expect(dry.json()).toMatchObject({ dryRun: true, scope: "all", deleted: { dmContexts: 1, dmStates: 1, memories: 1 } });
    const done = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { confirm: true, scope: "all" } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ dryRun: false, deleted: { dmStates: 1 } });
    expect(await readDmState(storage, USER, "aria")).toBeUndefined();
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    expect((await auditStore.list()).some((record) => record.action === "dm.forget")).toBe(true);
  });

  it("reports discord.dm in /api/runtime without a live runtime (nothing has the intent)", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const { app } = await api(storage, root);
    const response = await app.inject({ method: "GET", url: "/api/runtime" });
    expect(response.json().discord.dm).toEqual({ eligibleWaifus: [{ waifuId: "aria", botId: "aria-bot", intentActive: false }], warnings: [] });
  });
});
