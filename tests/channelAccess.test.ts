// Living cast §42: the House bot opens a channel to a waifu bot cast there that can't post in it,
// with an override for her bot alone, and closes only the overrides it added once she leaves.
// A fake gateway; no Discord calls.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import type { ChannelAccessResult, DiscordGatewayFacade } from "../src/discord/client.js";
import { OwnerNotices } from "../src/life/ownerNotices.js";
import { CHANNEL_ACCESS_PATH, ChannelAccessSync } from "../src/orchestration/channelAccess.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { DiscordBotsFileSchema, ServerConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "111111111111111111";
const VIP = "300000000000000001";
const GENERAL = "300000000000000002";
const VIP_THREAD = "300000000000000003";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;

async function world() {
  const root = await makeTempRoot();
  roots.push(root);
  const storage = new StorageService(root);
  for (const [id, botId] of [["lumi", "lumi-bot"], ["aria", "aria-bot"], ["nobot", undefined]] as const) {
    const record = WaifuConfigSchema.parse({ ...createRevisionedBase(), id, name: id, displayName: id[0]!.toUpperCase() + id.slice(1), ...(botId ? { botId } : {}) });
    await storage.writeJson(`waifu:${id}`, path.join("user", "waifus", id, "waifu.json"), WaifuConfigSchema, record);
  }
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse({
      ...createRevisionedBase(),
      orchestrator: { id: "house", displayName: "House", token: "t" },
      waifus: [{ id: "lumi-bot", displayName: "Lumi", token: "t" }, { id: "aria-bot", displayName: "Aria", token: "t" }]
    })
  );
  const cast = async (channels: Record<string, string[]>) => {
    const server = ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: GUILD,
      name: "Kingdom",
      channels: Object.fromEntries(Object.entries(channels).map(([id, ids]) => [id, { channelId: id, name: id === VIP ? "vip" : id === GENERAL ? "general" : "a-thread", enabledWaifuIds: ids }]))
    });
    await storage.writeJson(`server:${GUILD}`, path.join("user", "servers", GUILD, "server.json"), ServerConfigSchema, server);
  };

  // Discord: the channel overrides by channel, then bot user; who set them; who can post where.
  const overrides = new Map<string, { allow: string; deny: string; ours: boolean }>();
  const canPost = new Set<string>([`${GENERAL}:lumi-user`, `${GENERAL}:aria-user`]);
  const parentOf = new Map([[VIP_THREAD, VIP]]);
  const calls: string[] = [];
  let refuse: string | undefined;
  const discord: DiscordGatewayFacade = {
    openChannelFor: async ({ botId, channelId }): Promise<ChannelAccessResult> => {
      const userId = botId.replace("-bot", "-user");
      const channel = parentOf.get(channelId) ?? channelId;
      calls.push(`open ${channel} ${botId}`);
      if (canPost.has(`${channel}:${userId}`)) return { status: "open", channelId: channel };
      if (overrides.has(`${channel}:${userId}`)) return { status: "theirs", channelId: channel };
      if (refuse) throw new Error(refuse);
      overrides.set(`${channel}:${userId}`, { allow: "52224", deny: "0", ours: true });
      canPost.add(`${channel}:${userId}`);
      return { status: "opened", channelId: channel, botUserId: userId, allow: "52224" };
    },
    closeChannelFor: async ({ channelId, botUserId, allow }) => {
      calls.push(`close ${channelId} ${botUserId}`);
      const overwrite = overrides.get(`${channelId}:${botUserId}`);
      if (!overwrite) return "gone";
      if (overwrite.allow !== allow || overwrite.deny !== "0") return "kept";
      overrides.delete(`${channelId}:${botUserId}`);
      canPost.delete(`${channelId}:${botUserId}`);
      return "removed";
    }
  } as DiscordGatewayFacade;
  const notices = new OwnerNotices();
  const sync = new ChannelAccessSync({ storage, discord: () => discord, logger: quiet, notices, now: () => new Date("2026-11-01T15:00:00Z") });
  const grants = async () => (await storage.readJson(CHANNEL_ACCESS_PATH, (await import("zod")).z.any(), { grants: [] })).grants as Array<{ channelId: string; botId: string; for: string[] }>;
  return { root, storage, cast, overrides, canPost, calls, notices, sync, grants, refuse: (message: string | undefined) => (refuse = message) };
}

describe("channel access (§42)", () => {
  it("opens a channel to a cast waifu's bot that can't post there, once, and closes it when she leaves", async () => {
    const w = await world();
    await w.cast({ [GENERAL]: ["lumi", "aria"], [VIP]: ["lumi", "nobot"] });
    await w.sync.sync();
    expect(w.overrides.get(`${VIP}:lumi-user`)).toEqual({ allow: "52224", deny: "0", ours: true });
    // #general she can post in already, Aria isn't cast in #vip, and a waifu without a bot has nothing to open.
    expect(w.overrides.size).toBe(1);
    expect(await w.grants()).toEqual([{ guildId: GUILD, channelId: VIP, botId: "lumi-bot", botUserId: "lumi-user", allow: "52224", for: [VIP], at: "2026-11-01T15:00:00.000Z" }]);

    // Again: what it opened isn't asked about again.
    w.calls.length = 0;
    await w.sync.sync();
    expect(w.calls).toEqual([`open ${GENERAL} lumi-bot`, `open ${GENERAL} aria-bot`]);

    // The owner takes her out of #vip: the override goes, and the record with it.
    await w.cast({ [GENERAL]: ["lumi", "aria"], [VIP]: ["aria"] });
    await w.sync.sync();
    expect(w.overrides.has(`${VIP}:lumi-user`)).toBe(false);
    expect(await w.grants()).toEqual([{ guildId: GUILD, channelId: VIP, botId: "aria-bot", botUserId: "aria-user", allow: "52224", for: [VIP], at: "2026-11-01T15:00:00.000Z" }]);
  });

  it("never removes an override someone changed or set themselves", async () => {
    const w = await world();
    await w.cast({ [VIP]: ["lumi"] });
    await w.sync.sync();
    // An admin edits it (adds Manage Messages): it is theirs now.
    w.overrides.set(`${VIP}:lumi-user`, { allow: "60416", deny: "0", ours: false });
    await w.cast({ [VIP]: [] });
    await w.sync.sync();
    expect(w.overrides.get(`${VIP}:lumi-user`)?.allow).toBe("60416");
    expect(await w.grants()).toEqual([]);

    // An override someone set that still keeps her out: left alone, the owner is told.
    w.canPost.delete(`${VIP}:lumi-user`);
    await w.cast({ [VIP]: ["lumi"] });
    await w.sync.sync();
    expect(w.overrides.get(`${VIP}:lumi-user`)?.allow).toBe("60416");
    expect(w.notices.list()).toEqual([expect.stringMatching(/^Lumi in Kingdom #vip: her bot can't post there, and someone has set a channel override for it/u)]);
    // She leaves #vip: the notice goes too.
    await w.cast({ [VIP]: [] });
    await w.sync.sync();
    expect(w.notices.list()).toEqual([]);
  });

  it("tells the owner when the House bot can't, and clears it once it could", async () => {
    const w = await world();
    w.refuse("Missing Permissions");
    await w.cast({ [VIP]: ["lumi"] });
    await w.sync.sync();
    expect(w.notices.list()).toEqual([expect.stringMatching(/^Lumi in Kingdom #vip: her bot can't post there and the House bot couldn't open it \(Missing Permissions\)/u)]);
    expect(await w.grants()).toEqual([]);
    w.refuse(undefined);
    await w.sync.sync();
    expect(w.notices.list()).toEqual([]);
    expect(w.overrides.has(`${VIP}:lumi-user`)).toBe(true);
  });

  it("a thread with a cast of its own shares its channel's override, which stays while either wants it", async () => {
    const w = await world();
    await w.cast({ [VIP]: ["lumi"], [VIP_THREAD]: ["lumi"] });
    await w.sync.sync();
    expect((await w.grants()).map((g) => g.for)).toEqual([[VIP, VIP_THREAD]]);
    await w.cast({ [VIP_THREAD]: ["lumi"] });
    await w.sync.sync();
    expect(w.overrides.has(`${VIP}:lumi-user`)).toBe(true);
    expect((await w.grants()).map((g) => g.for)).toEqual([[VIP_THREAD]]);
    await w.cast({});
    await w.sync.sync();
    expect(w.overrides.has(`${VIP}:lumi-user`)).toBe(false);
  });

  it("does nothing with an unreadable record, and says so", async () => {
    const w = await world();
    await mkdir(path.join(w.root, "app"), { recursive: true });
    await writeFile(path.join(w.root, CHANNEL_ACCESS_PATH), "{ not json");
    await w.cast({ [VIP]: ["lumi"] });
    await w.sync.sync();
    expect(w.calls).toEqual([]);
    expect(w.notices.list()).toEqual([expect.stringMatching(/^app\/channel-access\.json is unreadable/u)]);
  });

  it("calls while a pass runs make one more pass after it", async () => {
    const w = await world();
    await w.cast({ [GENERAL]: ["lumi"] });
    await Promise.all([w.sync.sync(), w.sync.sync(), w.sync.sync()]);
    expect(w.calls).toEqual([`open ${GENERAL} lumi-bot`, `open ${GENERAL} lumi-bot`]);
  });
});

describe("channel access from the dashboard (§42)", () => {
  it("syncs after a server's channels or a waifu's bot link are saved, and after a server is removed", async () => {
    const w = await world();
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "0.1.0",
      port: 3888,
      dataRoot: w.root,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const syncChannelAccess = vi.fn();
    const server = await createApiServer({
      dataRoot: w.root,
      runtime,
      storage: w.storage,
      castRuntime: { syncChannelAccess, syncDiscordProfile: vi.fn(), reconcileDmIntents: async () => ({ relogged: [] }) } as never
    });
    try {
      const put = await server.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: { channels: { [VIP]: { channelId: VIP, enabledWaifuIds: ["lumi"] } } } });
      expect(put.statusCode).toBe(200);
      expect(put.json().channels[VIP].enabledWaifuIds).toEqual(["lumi"]);
      expect(syncChannelAccess).toHaveBeenCalledTimes(1);
      expect((await server.inject({ method: "DELETE", url: `/api/servers/${GUILD}/channels/${VIP}`, payload: {} })).statusCode).toBe(200);
      expect(syncChannelAccess).toHaveBeenCalledTimes(2);
      expect((await server.inject({ method: "PUT", url: "/api/waifus/lumi", payload: { revision: 0, botId: "aria-bot" } })).statusCode).toBe(200);
      expect(syncChannelAccess).toHaveBeenCalledTimes(3);
      expect((await server.inject({ method: "DELETE", url: `/api/servers/${GUILD}` })).statusCode).toBe(200);
      expect(syncChannelAccess).toHaveBeenCalledTimes(4);
    } finally {
      await server.close();
    }
  });
});

