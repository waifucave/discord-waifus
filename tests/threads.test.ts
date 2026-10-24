import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { PermissionWarningTracker, classifyDiscordSendError } from "../src/orchestration/permissionWarnings.js";
import { ensureServer } from "../src/orchestration/stores/config.js";
import {
  channelPlaceName,
  isLiveThread,
  isStaleThreadForResume,
  observeThread,
  overlayThreadChannels,
  parentSharesCast,
  readThreads,
  removeThread,
  resolveChannelConfig
} from "../src/orchestration/stores/threads.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ServerConfigSchema, type ServerConfig } from "../src/shared/schemas/domain.js";
import { THREAD_RESUME_WINDOW_MS, THREAD_RETENTION_MS } from "../src/shared/schemas/threads.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "123456789012345678";
const PARENT = "223456789012345678";
const THREAD = "323456789012345678";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function setup() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  return { root, storage: new StorageService(root) };
}

function serverWith(channels: Record<string, Partial<ServerConfig["channels"][string]>>): ServerConfig {
  return ServerConfigSchema.parse({
    ...createRevisionedBase(),
    guildId: GUILD,
    enabled: true,
    channels: Object.fromEntries(
      Object.entries(channels).map(([id, channel]) => [id, { channelId: id, enabled: true, enabledWaifuIds: [], ...channel }])
    )
  });
}

describe("threads store (spec 9.5, O2)", () => {
  it("observeThread records a thread, coalesces activity to a minute and writes only on change", async () => {
    const { storage } = await setup();
    const t0 = new Date("2026-10-24T10:00:00.000Z");
    const created = await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "Brownies", kind: "public_thread" }, t0);
    expect(created).toMatchObject({ threadId: THREAD, parentId: PARENT, name: "Brownies", archived: false, lastActivityAt: t0.toISOString() });
    const revision = (await readThreads(storage, GUILD)).revision;

    // Same facts again: no write.
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "Brownies" }, t0);
    expect((await readThreads(storage, GUILD)).revision).toBe(revision);

    // Activity within a minute is coalesced; later activity stamps.
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, activity: true }, new Date(t0.getTime() + 30_000));
    expect((await readThreads(storage, GUILD)).revision).toBe(revision);
    const later = new Date(t0.getTime() + 5 * 60_000);
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, activity: true }, later);
    expect((await readThreads(storage, GUILD)).threads[THREAD]!.lastActivityAt).toBe(later.toISOString());
  });

  it("tracks archive and lock state, and removeThread forgets a deleted thread", async () => {
    const { storage } = await setup();
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "x" });
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, archived: true });
    expect((await readThreads(storage, GUILD)).threads[THREAD]).toMatchObject({ archived: true, name: "x" });
    expect(await removeThread(storage, GUILD, THREAD)).toBe(true);
    expect(await removeThread(storage, GUILD, THREAD)).toBe(false);
    expect((await readThreads(storage, GUILD)).threads).toEqual({});
  });

  it("prunes threads idle for more than 30 days when another thread is observed", async () => {
    const { storage } = await setup();
    const old = new Date("2026-08-01T00:00:00.000Z");
    await observeThread(storage, GUILD, { threadId: "400000000000000001", parentId: PARENT }, old);
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT }, new Date(old.getTime() + THREAD_RETENTION_MS + 60_000));
    expect(Object.keys((await readThreads(storage, GUILD)).threads)).toEqual([THREAD]);
  });

  it("inherit (default): a live thread under a parent with a cast gets a virtual channel entry with the parent's cast", () => {
    const server = serverWith({ [PARENT]: { name: "recipes", enabledWaifuIds: ["aria", "mina"] } });
    const threads = { ...createRevisionedBase(), guildId: GUILD, threads: { [THREAD]: { threadId: THREAD, parentId: PARENT, name: "Best brownies", kind: "public_thread" as const, archived: false, locked: false, lastActivityAt: "2026-10-24T10:00:00.000Z" } } };
    const view = overlayThreadChannels(server, threads as never);
    expect(view.channels[THREAD]).toMatchObject({
      channelId: THREAD,
      enabledWaifuIds: ["aria", "mina"],
      thread: { parentId: PARENT }
    });
    expect(channelPlaceName(view, THREAD)).toBe('recipes › "Best brownies"');
    expect(channelPlaceName(view, PARENT)).toBe("recipes");
    // The overlay does not alias the parent's cast.
    view.channels[THREAD]!.enabledWaifuIds.push("zed");
    expect(server.channels[PARENT]!.enabledWaifuIds).toEqual(["aria", "mina"]);
  });

  it("off: a parent with threads off, or without a cast, gives its threads no entry", () => {
    const threads = { ...createRevisionedBase(), guildId: GUILD, threads: { [THREAD]: { threadId: THREAD, parentId: PARENT, name: "t", kind: "public_thread" as const, archived: false, locked: false, lastActivityAt: "2026-10-24T10:00:00.000Z" } } };
    const off = overlayThreadChannels(serverWith({ [PARENT]: { enabledWaifuIds: ["aria"], threads: "off" } }), threads as never);
    expect(off.channels[THREAD]).toBeUndefined();
    const none = overlayThreadChannels(serverWith({ [PARENT]: { enabledWaifuIds: [] } }), threads as never);
    expect(none.channels[THREAD]).toBeUndefined();
    expect(parentSharesCast(serverWith({ [PARENT]: { enabledWaifuIds: ["aria"], threads: "off" } }).channels[PARENT])).toBe(false);
    expect(parentSharesCast(serverWith({ [PARENT]: { enabledWaifuIds: ["aria"] } }).channels[PARENT])).toBe(true);
  });

  it("explicit: a thread with its own cast keeps it (even when the parent has threads off)", () => {
    const server = serverWith({
      [PARENT]: { enabledWaifuIds: ["aria"], threads: "off" },
      [THREAD]: { name: "mine", enabledWaifuIds: ["mina"] }
    });
    const threads = { ...createRevisionedBase(), guildId: GUILD, threads: { [THREAD]: { threadId: THREAD, parentId: PARENT, name: "t", kind: "public_thread" as const, archived: false, locked: false, lastActivityAt: "2026-10-24T10:00:00.000Z" } } };
    const view = overlayThreadChannels(server, threads as never);
    expect(view.channels[THREAD]!.enabledWaifuIds).toEqual(["mina"]);
    expect(view.channels[THREAD]!.thread).toMatchObject({ parentId: PARENT, explicit: true });
    expect(resolveChannelConfig(server, THREAD, PARENT)!.enabledWaifuIds).toEqual(["mina"]);
    // Without its own cast the same thread would inherit only if the parent allowed it.
    expect(resolveChannelConfig(serverWith({ [PARENT]: { enabledWaifuIds: ["aria"], threads: "off" } }), THREAD, PARENT)).toBeUndefined();
    expect(resolveChannelConfig(serverWith({ [PARENT]: { enabledWaifuIds: ["aria"] } }), THREAD, PARENT)).toMatchObject({ enabledWaifuIds: ["aria"], thread: { parentId: PARENT } });
  });

  it("archived and locked threads are silent; unarchiving resumes them", () => {
    const server = serverWith({ [PARENT]: { enabledWaifuIds: ["aria"] } });
    const record = (o: { archived: boolean; locked: boolean }) => ({
      ...createRevisionedBase(),
      guildId: GUILD,
      threads: { [THREAD]: { threadId: THREAD, parentId: PARENT, name: "t", kind: "public_thread" as const, lastActivityAt: "2026-10-24T10:00:00.000Z", ...o } }
    });
    expect(overlayThreadChannels(server, record({ archived: true, locked: false }) as never).channels[THREAD]).toBeUndefined();
    expect(overlayThreadChannels(server, record({ archived: false, locked: true }) as never).channels[THREAD]).toBeUndefined();
    expect(overlayThreadChannels(server, record({ archived: false, locked: false }) as never).channels[THREAD]).toBeDefined();
    expect(isLiveThread({ archived: false, locked: false })).toBe(true);
    expect(isLiveThread({ archived: true, locked: false })).toBe(false);
  });

  it("restart resume ignores threads idle for more than 24 hours", () => {
    const now = new Date("2026-10-24T12:00:00.000Z");
    const channel = (lastActivityAt?: string) => ({ channelId: THREAD, enabled: true, enabledWaifuIds: ["aria"], thread: { parentId: PARENT, ...(lastActivityAt ? { lastActivityAt } : {}) } });
    expect(isStaleThreadForResume(channel(new Date(now.getTime() - THREAD_RESUME_WINDOW_MS - 1000).toISOString()), now)).toBe(true);
    expect(isStaleThreadForResume(channel(new Date(now.getTime() - 3600_000).toISOString()), now)).toBe(false);
    expect(isStaleThreadForResume({ channelId: PARENT, enabled: true, enabledWaifuIds: ["aria"] }, now)).toBe(false);
  });

  it("ensureServer overlays tracked threads on the stored server", async () => {
    const { storage } = await setup();
    await storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: serverWith({}),
      transform: () => serverWith({ [PARENT]: { name: "recipes", enabledWaifuIds: ["aria"] } })
    });
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "Best brownies" });
    const server = await ensureServer(storage, GUILD);
    expect(server.channels[THREAD]).toMatchObject({ enabledWaifuIds: ["aria"], thread: { parentId: PARENT } });
    // The stored file stays clean: the overlay is runtime-only.
    const stored = await storage.readJson(`user/servers/${GUILD}/server.json`, ServerConfigSchema);
    expect(stored.channels[THREAD]).toBeUndefined();
  });
});

describe("send errors (spec 9.5)", () => {
  it("classifies 50083 as thread_archived and AutoMod codes as blocked/automod", () => {
    expect(classifyDiscordSendError({ code: 50083 })).toEqual({ status: "unavailable", reason: "thread_archived" });
    expect(classifyDiscordSendError({ code: 200000 })).toEqual({ status: "blocked", reason: "automod" });
    expect(classifyDiscordSendError({ code: 200001 })).toEqual({ status: "blocked", reason: "automod" });
    expect(classifyDiscordSendError({ code: 50013 })).toBeUndefined();
    expect(classifyDiscordSendError(new Error("boom"))).toBeUndefined();
    expect(classifyDiscordSendError(undefined)).toBeUndefined();
  });

  it("permission warnings for threads mention Send Messages in Threads; channel text is unchanged", () => {
    const tracker = new PermissionWarningTracker();
    tracker.record(GUILD, THREAD, "Aria", Object.assign(new Error("Missing Permissions"), { code: 50013 }), { thread: true });
    tracker.record(GUILD, PARENT, "Aria", Object.assign(new Error("Missing Access"), { code: 50001 }));
    const [threadWarning, channelWarning] = tracker.list();
    expect(threadWarning).toContain("Send Messages in Threads");
    expect(threadWarning).toContain(`thread ${THREAD}`);
    expect(channelWarning).not.toContain("Send Messages in Threads");
    expect(channelWarning).toContain(`channel ${PARENT}`);
    tracker.resolve(GUILD, THREAD);
    expect(tracker.list()).toHaveLength(1);
  });
});

describe("GET /api/servers/:guildId/threads", () => {
  async function makeApp() {
    const { root, storage } = await setup();
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
    const app = await createApiServer({ dataRoot: root, runtime, storage });
    return { app, storage };
  }

  it("is in the route policy manifest", () => {
    expect(ROUTE_POLICY_MANIFEST.some((entry) => entry.path === "/api/servers/:guildId/threads" && entry.method === "GET")).toBe(true);
  });

  it("returns the recorded threads, an empty file for a guild with none, and 400 for a non-snowflake id", async () => {
    const { app, storage } = await makeApp();
    try {
      await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "Best brownies", kind: "forum_post" });
      const ok = await app.inject({ method: "GET", url: `/api/servers/${GUILD}/threads` });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().threads[THREAD]).toMatchObject({ name: "Best brownies", kind: "forum_post", archived: false });
      const none = await app.inject({ method: "GET", url: "/api/servers/999999999999999999/threads" });
      expect(none.statusCode).toBe(200);
      expect(none.json().threads).toEqual({});
      for (const bad of ["abc", "12", "..%2Fetc", "1234567890123456789012345"]) {
        const res = await app.inject({ method: "GET", url: `/api/servers/${bad}/threads` });
        expect(res.statusCode, bad).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("a server PUT never stores the runtime-only thread marker of a channel (M1)", async () => {
    const { app, storage } = await makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/servers/${GUILD}`,
        payload: {
          channels: {
            [PARENT]: { channelId: PARENT, enabledWaifuIds: ["aria"], thread: { parentId: "1", silenced: true } }
          }
        }
      });
      expect(res.statusCode).toBe(200);
      const stored = await storage.readJson(`user/servers/${GUILD}/server.json`, ServerConfigSchema);
      expect(stored.channels[PARENT]).toMatchObject({ enabledWaifuIds: ["aria"] });
      expect(stored.channels[PARENT]!.thread).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
