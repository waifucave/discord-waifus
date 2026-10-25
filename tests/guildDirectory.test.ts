import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import {
  GuildDirectory,
  MEMBER_LIST_UNAVAILABLE,
  MemberListUnavailableError,
  type DirectoryTransport
} from "../src/discord/guildDirectory.js";
import {
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  GuildRolesFileSchema,
  type GuildEmojiCacheEntry,
  type GuildMemberCacheEntry,
  type GuildRoleCacheEntry
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { quietLogger, raw } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD = "100000000000000001";
const AT = "2026-10-24T14:00:00.000Z";

const member = (userId: string, name: string, extra: Partial<GuildMemberCacheEntry> = {}): GuildMemberCacheEntry => ({
  userId,
  username: name.toLowerCase(),
  guildDisplayName: name,
  bot: false,
  perChannelLastSeenAt: {},
  ...extra
});
const role = (id: string, name: string): GuildRoleCacheEntry => ({ id, name, color: 0, hoist: false, mentionable: false, managed: false, fetchedAt: AT });
const emoji = (id: string, name: string, extra: Partial<GuildEmojiCacheEntry> = {}): GuildEmojiCacheEntry => ({
  id, name, animated: false, available: true, roles: [], fetchedAt: AT, ...extra
});

class FakeTransport implements DirectoryTransport {
  members = new Map<string, GuildMemberCacheEntry>();
  fetchMemberCalls: string[] = [];
  listMembersCalls = 0;
  list: GuildMemberCacheEntry[] = [];
  listError: Error | undefined;
  failFetch: Error | undefined;
  hang = false;
  roles: GuildRoleCacheEntry[] = [];
  emojis: GuildEmojiCacheEntry[] = [];

  async fetchMember(_guildId: string, userId: string) {
    this.fetchMemberCalls.push(userId);
    if (this.hang) await new Promise<never>(() => undefined);
    if (this.failFetch) throw this.failFetch;
    return this.members.get(userId) ?? null;
  }
  async listMembers() {
    this.listMembersCalls += 1;
    if (this.listError) throw this.listError;
    return this.list;
  }
  async listRoles() {
    return this.roles;
  }
  async listEmojis() {
    return this.emojis;
  }
}

async function setup(o: { transport?: FakeTransport | null; hours?: number; now?: () => number; flushDelayMs?: number; mentionWaitMs?: number; bots?: boolean } = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  const storage = new StorageService(root);
  const transport = o.transport === null ? undefined : (o.transport ?? new FakeTransport());
  const directory = new GuildDirectory({
    storage,
    logger: quietLogger(),
    transport: async () => transport,
    settings: () => ({ memberListRefreshHours: o.hours ?? 24 }),
    ...(o.now ? { now: o.now } : {}),
    ...(o.flushDelayMs !== undefined ? { flushDelayMs: o.flushDelayMs } : {}),
    ...(o.mentionWaitMs !== undefined ? { mentionWaitMs: o.mentionWaitMs } : {}),
    ...(o.bots
      ? { bots: async () => ({ orchestrator: null, waifus: [{ id: "ella-bot", applicationId: "1300000000000000077", displayName: "Ella", enabled: true }] }) }
      : {})
  });
  const readMembers = () => storage.readJson(`user/servers/${GUILD}/members.json`, GuildMembersFileSchema);
  const readRoles = () => storage.readJson(`user/servers/${GUILD}/roles.json`, GuildRolesFileSchema);
  const readEmojis = () => storage.readJson(`user/servers/${GUILD}/emojis.json`, GuildEmojisFileSchema);
  return { root, storage, transport, directory, readMembers, readRoles, readEmojis };
}

describe("GuildDirectory loading and events", () => {
  it("starts empty when no files exist, loads existing ones lazily and keeps a channel-name fallback", async () => {
    const { storage, directory } = await setup();
    const empty = await directory.view(GUILD);
    expect(empty.memberName("1")).toBeUndefined();
    expect(empty.channelName("9")).toBeUndefined();

    await storage.writeJson("m", `user/servers/${GUILD}/members.json`, GuildMembersFileSchema, {
      schemaVersion: 2, revision: 1, updatedAt: AT, guildId: GUILD, members: [member("1", "Kevin")]
    });
    const fresh = new GuildDirectory({ storage, logger: quietLogger() });
    const view = await fresh.view(GUILD, (id) => (id === "9" ? "general" : undefined));
    expect(view.memberName("1")).toBe("Kevin");
    expect(view.channelName("9")).toBe("general");
    expect(view.roleName("x")).toBeUndefined();
    expect(view.emoji("x")).toBeUndefined();
  });

  it("maintains roles, emojis, channels and members from gateway events and writes them through", async () => {
    const { directory, readMembers, readRoles, readEmojis } = await setup();
    directory.handle({
      type: "snapshot", guildId: GUILD, name: "Bake Club",
      roles: [role("r1", "Bakers")], emojis: [emoji("e1", "wave"), emoji("e2", "gone", { available: false })],
      channels: [{ id: "c1", name: "general", kind: "channel" }, { id: "t1", name: "Best brownies", parentId: "c1", kind: "thread" }],
      members: [member("u1", "Kevin")]
    });
    const view = await directory.view(GUILD);
    expect(view.roleName("r1")).toBe("Bakers");
    expect(view.emoji("e1")).toBe("wave");
    expect(view.emoji("e2")).toBeUndefined(); // unavailable emoji render as :name: by the caller
    expect(view.channelName("t1")).toBe("Best brownies");
    expect(directory.channel(GUILD, "t1")).toMatchObject({ parentId: "c1", kind: "thread" });
    expect(view.memberName("u1")).toBe("Kevin");

    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r1", "Chefs") });
    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r2", "Mods") });
    directory.handle({ type: "roleDelete", guildId: GUILD, roleId: "r2" });
    directory.handle({ type: "emojiUpsert", guildId: GUILD, emoji: emoji("e3", "heart") });
    directory.handle({ type: "emojiDelete", guildId: GUILD, emojiId: "e1" });
    directory.handle({ type: "channelUpsert", guildId: GUILD, channel: { id: "c1", name: "chat", kind: "channel" } });
    directory.handle({ type: "channelDelete", guildId: GUILD, channelId: "t1" });
    directory.handle({ type: "memberUpsert", guildId: GUILD, member: member("u2", "Riko") });
    directory.handle({ type: "memberUpsert", guildId: GUILD, member: member("u1", "Kev", { globalDisplayName: "Kevin" }) });
    directory.handle({ type: "memberRemove", guildId: GUILD, userId: "u2" });
    expect(view.roleName("r1")).toBe("Chefs");
    expect(view.roleName("r2")).toBeUndefined();
    expect(view.emoji("e3")).toBe("heart");
    expect(view.emoji("e1")).toBeUndefined();
    expect(view.channelName("c1")).toBe("chat");
    expect(view.channelName("t1")).toBeUndefined();
    expect(view.memberName("u2")).toBeUndefined();
    expect(view.memberName("u1")).toBe("Kev");

    await directory.flush();
    expect((await readRoles()).roles.map((r) => r.name)).toEqual(["Chefs"]);
    expect((await readEmojis()).emojis.map((e) => e.name).sort()).toEqual(["gone", "heart"]);
    expect((await readMembers()).members.map((m) => m.guildDisplayName)).toEqual(["Kev"]);
  });

  it("applies events that arrive before the files finished loading, in order", async () => {
    const { directory } = await setup();
    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r1", "First") });
    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r1", "Second") });
    const view = await directory.view(GUILD);
    expect(view.roleName("r1")).toBe("Second");
  });

  it("debounces the write-through, and a snapshot that changes nothing writes nothing", async () => {
    const { storage, directory } = await setup({ flushDelayMs: 150 });
    const read = () => storage.readJson(`user/servers/${GUILD}/roles.json`, GuildRolesFileSchema);
    await directory.view(GUILD);
    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r1", "Bakers") });
    await new Promise((resolve) => setTimeout(resolve, 60));
    directory.handle({ type: "roleUpsert", guildId: GUILD, role: role("r2", "Mods") });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(read()).rejects.toThrow(/ENOENT/); // still inside the debounce window
    await vi.waitFor(async () => expect((await read()).roles).toHaveLength(2), { timeout: 2_000 });
    const revision = (await read()).revision;

    directory.handle({ type: "snapshot", guildId: GUILD, roles: [role("r1", "Bakers"), role("r2", "Mods")], emojis: [], channels: [], members: [] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await read()).revision).toBe(revision);
    await directory.close();
  });

  it("merges configured bots so their names resolve, without persisting them", async () => {
    const { directory, readMembers } = await setup({ bots: true });
    const view = await directory.view(GUILD);
    expect(view.memberName("1300000000000000077")).toBe("Ella"); // the application id; "ella-bot" is not a snowflake
    directory.handle({ type: "memberUpsert", guildId: GUILD, member: member("u1", "Kevin") });
    await directory.flush();
    expect((await readMembers()).members.map((m) => m.userId)).toEqual(["u1"]);
  });
});

describe("GuildDirectory learns from messages", () => {
  it("adds authors and mentioned users, keeps richer entries, and only writes on a real change", async () => {
    const { directory, readMembers } = await setup();
    await directory.view(GUILD);
    directory.handle({ type: "memberUpsert", guildId: GUILD, member: member("kevin", "Kevin", { globalDisplayName: "Kevin G", username: "kev" }) });
    await directory.flush();
    const revision = (await readMembers()).revision;

    directory.observeMessages(GUILD, [
      raw({ authorId: "kevin", authorName: "Kevin", channelId: "c1", mentions: { users: { riko: "Riko" }, roles: {}, channels: {} } }),
      raw({ authorId: "ella", authorName: "Ella", authorIsBot: true })
    ]);
    expect(directory.memberName(GUILD, "riko")).toBe("Riko");
    expect(directory.memberName(GUILD, "ella")).toBe("Ella");
    await directory.flush();
    const saved = await readMembers();
    expect(saved.revision).toBeGreaterThan(revision); // riko and ella are new
    expect(saved.members.find((m) => m.userId === "kevin")).toMatchObject({ username: "kev", globalDisplayName: "Kevin G" });
    expect(saved.members.find((m) => m.userId === "ella")).toMatchObject({ bot: true });

    // Nothing but recency changed: no write.
    const again = saved.revision;
    directory.observeMessages(GUILD, [raw({ authorId: "kevin", authorName: "Kevin", channelId: "c1" })]);
    await directory.flush();
    expect((await readMembers()).revision).toBe(again);

    // A renamed author is picked up.
    directory.observeMessages(GUILD, [raw({ authorId: "kevin", authorName: "Kev the Baker" })]);
    expect(directory.memberName(GUILD, "kevin")).toBe("Kev the Baker");
    // A mention's name never overrides an author's.
    directory.observeMessages(GUILD, [raw({ authorId: "riko", authorName: "Riko", mentions: { users: { kevin: "Old Kevin" }, roles: {}, channels: {} } })]);
    expect(directory.memberName(GUILD, "kevin")).toBe("Kev the Baker");
  });
});

describe("GuildDirectory unresolved mentions", () => {
  const mention = (id: string, extra: Partial<Parameters<typeof raw>[0]> = {}) => raw({ content: `hey <@${id}>`, ...extra });

  it("fetches one member per unresolved id, once, and remembers a miss for 10 minutes", async () => {
    const clock = { now: 1_000 };
    const transport = new FakeTransport();
    transport.members.set("42", member("42", "Dana"));
    const { directory } = await setup({ transport, now: () => clock.now });

    await directory.resolveMentions(GUILD, [mention("42"), mention("43"), mention("42")]);
    expect(transport.fetchMemberCalls.sort()).toEqual(["42", "43"]);
    expect(directory.memberName(GUILD, "42")).toBe("Dana");
    expect(directory.memberName(GUILD, "43")).toBeUndefined();

    await directory.resolveMentions(GUILD, [mention("42"), mention("43")]); // known + negative-cached
    expect(transport.fetchMemberCalls).toHaveLength(2);
    clock.now += 9 * 60_000;
    await directory.resolveMentions(GUILD, [mention("43")]);
    expect(transport.fetchMemberCalls).toHaveLength(2);
    clock.now += 2 * 60_000;
    await directory.resolveMentions(GUILD, [mention("43")]);
    expect(transport.fetchMemberCalls).toHaveLength(3);
  });

  it("skips ids the payload already names and ids already in the directory", async () => {
    const transport = new FakeTransport();
    const { directory } = await setup({ transport });
    directory.handle({ type: "memberUpsert", guildId: GUILD, member: member("known", "Known") });
    await directory.resolveMentions(GUILD, [
      mention("named", { mentions: { users: { named: "Named" }, roles: {}, channels: {} } }),
      mention("known")
    ]);
    expect(transport.fetchMemberCalls).toEqual([]);
  });

  it("fetches at most 5 members per call", async () => {
    const transport = new FakeTransport();
    const { directory } = await setup({ transport });
    await directory.resolveMentions(GUILD, ["1", "2", "3", "4", "5", "6", "7"].map((id) => mention(id)));
    expect(transport.fetchMemberCalls).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("waits only mentionWaitMs (1.5 s by default), lets the fetch finish in the background, and retries a failure after a minute", async () => {
    const clock = { now: 0 };
    const transport = new FakeTransport();
    transport.members.set("77", member("77", "Late"));
    const { directory } = await setup({ transport, now: () => clock.now, mentionWaitMs: 40 });
    transport.hang = true;
    const started = Date.now();
    await directory.resolveMentions(GUILD, [mention("77")]);
    expect(Date.now() - started).toBeLessThan(1_000); // returned at the wait limit, not when the fetch ends
    expect(directory.memberName(GUILD, "77")).toBeUndefined();

    transport.hang = false;
    transport.failFetch = new Error("500");
    clock.now = 10_000;
    await directory.resolveMentions(GUILD, [mention("78")]);
    clock.now += 30_000;
    await directory.resolveMentions(GUILD, [mention("78")]);
    expect(transport.fetchMemberCalls.filter((id) => id === "78")).toHaveLength(1);
    clock.now += 40_000;
    await directory.resolveMentions(GUILD, [mention("78")]);
    expect(transport.fetchMemberCalls.filter((id) => id === "78")).toHaveLength(2);
  });

  it("an abort ends the wait, and a missing bot token makes it a no-op", async () => {
    const hanging = new FakeTransport();
    hanging.hang = true;
    const a = await setup({ transport: hanging });
    const controller = new AbortController();
    const waiting = a.directory.resolveMentions(GUILD, [mention("9")], { signal: controller.signal });
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();

    const b = await setup({ transport: null });
    await expect(b.directory.resolveMentions(GUILD, [mention("9")])).resolves.toBeUndefined();
  });
});

describe("GuildDirectory refresh and member list status", () => {
  it("refreshes members from the list endpoint and writes the file immediately", async () => {
    const transport = new FakeTransport();
    transport.list = [member("1", "Kevin"), member("2", "Riko")];
    const clock = { now: Date.parse(AT) };
    const { directory, readMembers } = await setup({ transport, now: () => clock.now });
    expect(directory.status()).toEqual({ memberListAvailable: null, lastRefreshAt: null, warnings: [] });

    const result = await directory.refresh(GUILD, "members");
    expect(result).toMatchObject({ accepted: true, count: 2, message: "Fetched 2 members from Discord." });
    expect((await readMembers()).members.map((m) => m.userId)).toEqual(["1", "2"]);
    expect(directory.status()).toEqual({ memberListAvailable: true, lastRefreshAt: AT, warnings: [] });
  });

  it("refreshes roles and emojis, and reports a missing token without throwing", async () => {
    const transport = new FakeTransport();
    transport.roles = [role("r1", "Bakers")];
    transport.emojis = [emoji("e1", "wave")];
    const { directory, readRoles, readEmojis } = await setup({ transport });
    expect(await directory.refresh(GUILD, "roles")).toMatchObject({ accepted: true, message: "Fetched 1 server roles from Discord." });
    expect(await directory.refresh(GUILD, "emojis")).toMatchObject({ accepted: true, message: "Fetched 1 server emojis from Discord." });
    expect((await readRoles()).roles[0]!.name).toBe("Bakers");
    expect((await readEmojis()).emojis[0]!.name).toBe("wave");

    const none = await setup({ transport: null });
    expect(await none.directory.refresh(GUILD, "members")).toEqual({
      accepted: false,
      message: "Discord bot token is not configured. Save the House bot first."
    });
  });

  it("a 403 on the member list marks it unavailable with a member_list_unavailable warning and stops the periodic refresh", async () => {
    const transport = new FakeTransport();
    transport.listError = new MemberListUnavailableError("Missing Access");
    const clock = { now: 0 };
    const { directory } = await setup({ transport, now: () => clock.now });
    await directory.view(GUILD);

    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(1);
    expect(directory.status()).toEqual({ memberListAvailable: false, lastRefreshAt: null, warnings: [MEMBER_LIST_UNAVAILABLE] });

    clock.now += 23 * 3_600_000;
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(1); // not retried every tick while it does not work
    clock.now += 2 * 3_600_000;
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(2); // once per memberListRefreshHours
    expect(directory.status().memberListAvailable).toBe(false);

    // A manual refresh after the intent was granted brings it back.
    transport.listError = undefined;
    transport.list = [member("1", "Kevin")];
    await directory.refresh(GUILD, "members");
    expect(directory.status().memberListAvailable).toBe(true);
    expect(directory.status().warnings).toEqual([]);
  });

  it("refreshes the member list every memberListRefreshHours while the endpoint works (0 = never)", async () => {
    const transport = new FakeTransport();
    transport.list = [member("1", "Kevin")];
    const clock = { now: 0 };
    const hours = { value: 24 };
    const root = await makeTempRoot();
    roots.push(root);
    const directory = new GuildDirectory({
      storage: new StorageService(root),
      logger: quietLogger(),
      transport: async () => transport,
      settings: () => ({ memberListRefreshHours: hours.value }),
      now: () => clock.now
    });
    await directory.view(GUILD);

    await directory.runMaintenance(); // first tick after boot: never refreshed, so due
    expect(transport.listMembersCalls).toBe(1);
    clock.now += 23 * 3_600_000;
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(1);
    clock.now += 2 * 3_600_000;
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(2);

    hours.value = 0;
    clock.now += 100 * 3_600_000;
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(2);

    // A transient failure is retried on the next tick and does not flip availability.
    hours.value = 1;
    transport.listError = new Error("502");
    await directory.runMaintenance();
    await directory.runMaintenance();
    expect(transport.listMembersCalls).toBe(4);
    expect(directory.status().memberListAvailable).toBe(true);
  });
});

describe("GuildDirectory in the API", () => {
  async function api(directory: GuildDirectory, root: string) {
    await ensureDataLayout(root);
    const runtime = createRuntimeState({
      pid: process.pid, startedAt: AT, packageVersion: "0.1.0", port: 3888, dataRoot: root, mode: "test", paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    return createApiServer({ dataRoot: root, runtime, storage: new StorageService(root), directory });
  }

  it("serves discord.directory in /api/runtime", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const transport = new FakeTransport();
    transport.list = [member("1", "Kevin")];
    const directory = new GuildDirectory({ storage: new StorageService(root), logger: quietLogger(), transport: async () => transport });
    const app = await api(directory, root);
    try {
      const before = (await app.inject({ method: "GET", url: "/api/runtime" })).json();
      expect(before.discord.directory).toEqual({ memberListAvailable: null, lastRefreshAt: null, warnings: [] });
      await directory.refresh(GUILD, "members");
      const after = (await app.inject({ method: "GET", url: "/api/runtime" })).json();
      expect(after.discord.directory).toMatchObject({ memberListAvailable: true, warnings: [] });
      expect(typeof after.discord.directory.lastRefreshAt).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("routes the refresh buttons through GuildDirectory.refresh and maps Discord errors to 400", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const transport = new FakeTransport();
    transport.list = [member("1", "Kevin")];
    transport.roles = [role("r1", "Bakers")];
    transport.emojis = [emoji("e1", "wave")];
    const directory = new GuildDirectory({ storage: new StorageService(root), logger: quietLogger(), transport: async () => transport });
    const app = await api(directory, root);
    try {
      const members = await app.inject({ method: "POST", url: `/api/servers/${GUILD}/members/refresh` });
      expect(members.statusCode).toBe(200);
      expect(members.json()).toMatchObject({ accepted: true, guildId: GUILD, message: "Fetched 1 members from Discord.", members: { members: [{ userId: "1" }] } });
      const roles = await app.inject({ method: "POST", url: `/api/servers/${GUILD}/roles/refresh` });
      expect(roles.json()).toMatchObject({ accepted: true, roles: { roles: [{ name: "Bakers" }] } });
      const emojis = await app.inject({ method: "POST", url: `/api/servers/${GUILD}/emojis/refresh` });
      expect(emojis.json()).toMatchObject({ accepted: true, emojis: { emojis: [{ name: "wave" }] } });

      transport.listError = new MemberListUnavailableError("Discord refused the member list (403)");
      const refused = await app.inject({ method: "POST", url: `/api/servers/${GUILD}/members/refresh` });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toContain("403");
    } finally {
      await app.close();
    }
  });
});

describe("GuildDirectory boot check and negative cache pruning", () => {
  it("learns memberListAvailable shortly after boot instead of after the first 15-minute tick (M5)", async () => {
    const transport = new FakeTransport();
    transport.listError = new MemberListUnavailableError("Missing Access");
    const root = await makeTempRoot();
    roots.push(root);
    const directory = new GuildDirectory({
      storage: new StorageService(root),
      logger: quietLogger(),
      transport: async () => transport,
      bootCheckDelayMs: 10,
      maintenanceIntervalMs: 3_600_000
    });
    let push: ((event: Parameters<GuildDirectory["handle"]>[0]) => void) | undefined;
    directory.start((listener) => {
      push = listener;
      return () => undefined;
    });
    push!({ type: "snapshot", guildId: GUILD, roles: [], emojis: [], channels: [], members: [] });
    await vi.waitFor(() => expect(directory.status().memberListAvailable).toBe(false), { timeout: 2_000 });
    expect(directory.status().warnings).toEqual([MEMBER_LIST_UNAVAILABLE]);
    await directory.close();
  });

  it("drops expired negative-cache entries (M7)", async () => {
    const clock = { now: 0 };
    const transport = new FakeTransport();
    const { directory } = await setup({ transport, now: () => clock.now });
    const negativeSize = () => (directory as unknown as { guilds: Map<string, { negative: Map<string, number> }> }).guilds.get(GUILD)!.negative.size;
    await directory.resolveMentions(GUILD, [raw({ content: "<@1> <@2> <@3>" })]);
    expect(negativeSize()).toBe(3);
    clock.now += 11 * 60_000;
    await directory.runMaintenance();
    expect(negativeSize()).toBe(0);

    await directory.resolveMentions(GUILD, [raw({ content: "<@4>" })]);
    expect(negativeSize()).toBe(1);
    clock.now += 11 * 60_000;
    await directory.resolveMentions(GUILD, [raw({ content: "<@4>" })]); // expired: fetched again, re-added fresh
    expect(transport.fetchMemberCalls.filter((id) => id === "4")).toHaveLength(2);
    expect(negativeSize()).toBe(1);
  });
});
