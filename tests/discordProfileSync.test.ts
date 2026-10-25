// Living cast §17: her own bot's Discord profile (username, avatar, banner, bio, nicknames) synced
// from her config. Fake bot handles only; no Discord calls.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, Events } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { prebuiltWaifuRecord } from "../src/config/layout.js";
import { DiscordJsGateway, profileEditRateLimitFilter, type DiscordJsGatewayOptions } from "../src/discord/client.js";
import {
  DiscordProfileSync,
  USERNAME_RATE_LIMIT_FALLBACK_MS,
  classifyProfileError,
  desiredUsername,
  discordProfileStatus,
  planProfileSync,
  sniffImageMime,
  type BotProfileGuild,
  type BotProfileHandle,
  type BotProfileRecord,
  type BotProfileUser
} from "../src/discord/profileSync.js";
import { UpdateWaifuBodySchema } from "../src/shared/schemas/api.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { DiscordBotsFileSchema, WaifuConfigSchema, type DiscordBotConfig } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const GIF = Buffer.from("GIF89a....", "latin1");

let roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function root(): Promise<{ root: string; storage: StorageService }> {
  const dir = await makeTempRoot();
  roots.push(dir);
  return { root: dir, storage: new StorageService(dir) };
}

async function writeWaifu(storage: StorageService, waifu: Record<string, unknown>) {
  const record = WaifuConfigSchema.parse({ ...createRevisionedBase(), displayName: waifu.name, ...waifu });
  await storage.writeJson(`waifu:${record.id}`, path.join("user", "waifus", record.id, "waifu.json"), WaifuConfigSchema, record);
}

async function writeBots(storage: StorageService, waifuBotIds: string[]) {
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse({
      ...createRevisionedBase(),
      orchestrator: { id: "house", displayName: "House", token: "house-token" },
      waifus: waifuBotIds.map((id) => ({ id, displayName: id, token: `${id}-token` }))
    })
  );
}

async function writeImage(rootDir: string, waifuId: string, file: string, bytes: Buffer) {
  await mkdir(path.join(rootDir, "user", "waifus", waifuId), { recursive: true });
  await writeFile(path.join(rootDir, "user", "waifus", waifuId, file), bytes);
}

type FakeBot = BotProfileHandle & {
  state: { user: BotProfileUser; description: string; guilds: BotProfileGuild[] };
  editUser: ReturnType<typeof vi.fn>;
  editApplicationDescription: ReturnType<typeof vi.fn>;
  fetchApplicationDescription: ReturnType<typeof vi.fn>;
  setNickname: ReturnType<typeof vi.fn>;
};

/** A connected waifu bot as Discord would answer: avatar hashes change on every upload. */
function fakeBot(init: Partial<FakeBot["state"]> = {}): FakeBot {
  const state: FakeBot["state"] = {
    user: { id: "900000000000000001", username: "old-name", avatar: null, banner: null },
    description: "",
    guilds: [],
    ...init
  };
  let uploads = 0;
  const bot = {
    state,
    user: () => ({ ...state.user }),
    editUser: vi.fn(async (patch: { username?: string; avatar?: string; banner?: string }) => {
      if (patch.username !== undefined) state.user.username = patch.username;
      if (patch.avatar !== undefined) state.user.avatar = `a_hash_${++uploads}`;
      if (patch.banner !== undefined) state.user.banner = `b_hash_${++uploads}`;
      return { ...state.user };
    }),
    fetchApplicationDescription: vi.fn(async () => state.description),
    editApplicationDescription: vi.fn(async (description: string) => {
      state.description = description;
    }),
    guilds: () => state.guilds.map((guild) => ({ ...guild })),
    setNickname: vi.fn(async (guildId: string, nick: string | null) => {
      const guild = state.guilds.find((entry) => entry.guildId === guildId)!;
      guild.nickname = nick;
    })
  };
  return bot as unknown as FakeBot;
}

function service(storage: StorageService, bots: Record<string, BotProfileHandle>, clock = { now: Date.parse("2026-10-25T12:00:00Z") }) {
  return new DiscordProfileSync({
    storage,
    discord: () => ({ waifuBotProfile: (botId) => bots[botId], connectedWaifuBotIds: () => Object.keys(bots) }),
    now: () => clock.now
  });
}

describe("profile schema", () => {
  it("validates her Discord username, bio and nicknames with clear errors", () => {
    const parse = (patch: Record<string, unknown>) => UpdateWaifuBodySchema.safeParse({ revision: 1, ...patch });
    expect(parse({ username: "  Aria  " }).data?.username).toBe("Aria");
    for (const [username, message] of [
      ["A", "2 to 32"],
      ["x".repeat(33), "2 to 32"],
      ["aria@home", '"@"'],
      ["aria#1", '"#"'],
      ["a:b", '":"'],
      ["a```b", '"```"'],
      ["MyDiscordBot", '"discord"'],
      ["Clyde Jr", '"clyde"'],
      ["everyone", "reserved"]
    ] as const) {
      const result = parse({ username });
      expect(result.success, username).toBe(false);
      expect(result.error!.issues.map((issue) => issue.message).join(" "), username).toContain(message);
    }
    expect(parse({ bio: "x".repeat(400) }).success).toBe(true);
    expect(parse({ bio: "x".repeat(401) }).error!.issues[0]!.message).toContain("400");
    expect(parse({ nicknames: { [GUILD_A]: "Ari" } }).success).toBe(true);
    expect(parse({ nicknames: { "not-a-guild": "Ari" } }).error!.issues[0]!.message).toContain("guild");
    expect(parse({ nicknames: { [GUILD_A]: "x".repeat(33) } }).success).toBe(false);
    expect(parse({ nicknames: { [GUILD_A]: "  " } }).success).toBe(false);
    // null unsets; omitted leaves the stored value alone.
    const unset = parse({ username: null, bio: null, nicknames: null }).data!;
    expect(unset.username).toBeUndefined();
    expect("bio" in parse({}).data!).toBe(false);
  });

  it("falls back to her display name, then her name, for the bot username", () => {
    expect(desiredUsername({ username: "Ari", displayName: "Aria", name: "aria" })).toMatchObject({ value: "Ari", source: "username" });
    expect(desiredUsername({ displayName: "Aria", name: "aria" })).toMatchObject({ value: "Aria", source: "displayName" });
    expect(desiredUsername({ displayName: "Discord Aria", name: "aria" })).toMatchObject({ value: "aria", source: "name" });
    const none = desiredUsername({ displayName: "A", name: "B" });
    expect(none.value).toBeNull();
    expect(none.warning?.code).toBe("username_fallback_invalid");
  });

  it("sniffs the image type from its bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<svg/>"))).toBeUndefined();
  });

  it("carries a prebuilt waifu's username and bio into her first record", () => {
    const base = { id: "lumi", name: "Lumi", displayName: "Lumi", enabled: true, persona: "Warm.", availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] } };
    const record = prebuiltWaifuRecord({ ...base, username: "Lumi", bio: "Cozy and bright." });
    expect(record).toMatchObject({ username: "Lumi", bio: "Cozy and bright." });
    expect("username" in prebuiltWaifuRecord(base)).toBe(false);
  });
});

describe("planProfileSync", () => {
  const empty: BotProfileRecord = { waifuId: "aria", nicknames: {}, pendingFields: [], retryAfter: {}, warnings: [] };
  const user: BotProfileUser = { id: "1", username: "Aria", avatar: "a1", banner: null };

  it("sends only the fields that differ", () => {
    const plan = planProfileSync({
      desired: { username: "Aria", nicknames: {}, avatarHash: "h1" },
      user,
      guilds: [],
      record: { ...empty, avatar: { contentHash: "h1", discordHash: "a1" } },
      now: 0
    });
    expect(plan.user).toEqual({});
    expect(plan.pending).toEqual([]);
    const changed = planProfileSync({ desired: { username: "Ari", nicknames: {}, avatarHash: "h2", bio: "hi" }, user, guilds: [], record: empty, now: 0 });
    expect(changed.user).toEqual({ username: "Ari", avatar: true });
    expect(changed.bio).toBe("hi");
  });

  it("re-uploads her image when Discord shows another one", () => {
    const plan = planProfileSync({
      desired: { username: null, nicknames: {}, avatarHash: "h1" },
      user: { ...user, avatar: "someone-else" },
      guilds: [],
      record: { ...empty, avatar: { contentHash: "h1", discordHash: "a1" } },
      now: 0
    });
    expect(plan.user).toEqual({ avatar: true });
  });

  it("holds a field back until its retry time", () => {
    const plan = planProfileSync({
      desired: { username: "Ari", nicknames: {} },
      user,
      guilds: [],
      record: { ...empty, retryAfter: { username: new Date(60_000).toISOString() } },
      now: 1_000
    });
    expect(plan.user).toEqual({});
    expect(plan.waiting).toEqual(["username"]);
    expect(plan.pending).toEqual(["username"]);
  });
});

describe("classifyProfileError", () => {
  it("reads discord.js rate limits, 429s, Discord's username limit and missing permissions", () => {
    expect(classifyProfileError(Object.assign(new Error("limited"), { name: "RateLimitError", retryAfter: 5_000 }))).toEqual({ kind: "rate_limited", retryAfterMs: 5_000, usernameOnly: false });
    expect(classifyProfileError({ status: 429, code: 0, rawError: { retry_after: 12.5 } })).toMatchObject({ kind: "rate_limited", retryAfterMs: 12_500 });
    expect(
      classifyProfileError({ status: 400, code: 50035, message: "Invalid Form Body", rawError: { errors: { username: { _errors: [{ code: "USERNAME_RATE_LIMIT", message: "You are changing your username too fast." }] } } } })
    ).toEqual({ kind: "rate_limited", retryAfterMs: USERNAME_RATE_LIMIT_FALLBACK_MS, usernameOnly: true });
    expect(classifyProfileError({ status: 403, code: 50013, message: "Missing Permissions" })).toEqual({ kind: "missing_permission" });
    expect(classifyProfileError(new Error("boom"))).toEqual({ kind: "error", message: "boom" });
  });
});

describe("DiscordProfileSync", () => {
  it("syncs username, avatar, banner and bio once, and nothing again after a reconnect", async () => {
    const { root: dir, storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria", username: "Aria", bio: "Sunny baker." });
    await writeImage(dir, "aria", "pfp.png", PNG);
    await writeImage(dir, "aria", "banner.gif", GIF);
    const bot = fakeBot();
    await service(storage, { aria: bot }).syncAll();
    expect(bot.editUser).toHaveBeenCalledTimes(1);
    const patch = bot.editUser.mock.calls[0]![0] as Record<string, string>;
    expect(patch.username).toBe("Aria");
    expect(patch.avatar).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(patch.banner).toMatch(/^data:image\/gif;base64,/u);
    expect(bot.editApplicationDescription).toHaveBeenCalledExactlyOnceWith("Sunny baker.");

    // A reconnect (a new service, as after a restart): the same bytes are not uploaded again.
    const again = service(storage, { aria: bot });
    await again.syncBot("aria");
    expect(bot.editUser).toHaveBeenCalledTimes(1);
    expect(bot.editApplicationDescription).toHaveBeenCalledTimes(1);
    expect((await again.status("aria"))?.state).toBe("synced");

    // A new avatar goes up alone.
    await writeImage(dir, "aria", "pfp.png", PNG2);
    await again.syncWaifu("aria");
    expect(bot.editUser).toHaveBeenCalledTimes(2);
    expect(Object.keys(bot.editUser.mock.calls[1]![0] as object)).toEqual(["avatar"]);
    const status = await again.status("aria");
    expect(status).toMatchObject({ state: "synced", images: { avatar: { contentType: "image/png", synced: true }, banner: { synced: true } } });
  });

  it("records a rate limit with its retry time, waits, then retries", async () => {
    const { storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria", username: "Ari" });
    const bot = fakeBot();
    bot.editUser.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 30 * 60_000 }));
    const clock = { now: Date.parse("2026-10-25T12:00:00Z") };
    const sync = service(storage, { aria: bot }, clock);
    await sync.syncBot("aria");
    let status = (await sync.status("aria"))!;
    expect(status.state).toBe("rate_limited");
    expect(status.pendingFields).toEqual(["username"]);
    expect(Date.parse(status.retryAfter!)).toBeGreaterThan(clock.now + 29 * 60_000);

    // Reconnects before the retry time do not hammer Discord.
    await sync.syncBot("aria");
    await service(storage, { aria: bot }, clock).syncBot("aria");
    expect(bot.editUser).toHaveBeenCalledTimes(1);

    clock.now += 31 * 60_000;
    await sync.syncBot("aria");
    expect(bot.editUser).toHaveBeenCalledTimes(2);
    status = (await sync.status("aria"))!;
    expect(status.state).toBe("synced");
    expect(bot.state.user.username).toBe("Ari");
    await sync.stop();
  });

  it("sends the images on their own when Discord's username limit refuses the whole request", async () => {
    const { root: dir, storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria", username: "Ari" });
    await writeImage(dir, "aria", "pfp.png", PNG);
    const bot = fakeBot();
    bot.editUser.mockRejectedValueOnce({
      status: 400,
      code: 50035,
      message: "Invalid Form Body",
      rawError: { errors: { username: { _errors: [{ code: "USERNAME_RATE_LIMIT", message: "too fast" }] } } }
    });
    const sync = service(storage, { aria: bot });
    await sync.syncBot("aria");
    expect(bot.editUser).toHaveBeenCalledTimes(2);
    expect(Object.keys(bot.editUser.mock.calls[1]![0] as object)).toEqual(["avatar"]);
    const status = (await sync.status("aria"))!;
    expect(status.state).toBe("rate_limited");
    expect(Object.keys(status.retryAfterByField)).toEqual(["username"]);
    expect(status.images.avatar?.synced).toBe(true);
    await sync.stop();
  });

  it("sets per-server nicknames and warns where the Change Nickname permission is missing", async () => {
    const { storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria", nicknames: { [GUILD_A]: "Ari", [GUILD_B]: "Bee" } });
    const bot = fakeBot({
      user: { id: "900000000000000001", username: "Aria", avatar: null, banner: null },
      guilds: [
        { guildId: GUILD_A, nickname: null, canChangeNickname: true },
        { guildId: GUILD_B, nickname: null, canChangeNickname: false }
      ]
    });
    const sync = service(storage, { aria: bot });
    await sync.syncBot("aria");
    expect(bot.setNickname).toHaveBeenCalledExactlyOnceWith(GUILD_A, "Ari");
    expect(bot.editUser).not.toHaveBeenCalled();
    const status = (await sync.status("aria"))!;
    expect(status.state).toBe("synced");
    expect(status.warnings).toEqual([expect.objectContaining({ code: "missing_permission", guildId: GUILD_B })]);

    // Removing the override clears only the nickname the app set.
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria" });
    await sync.syncBot("aria");
    expect(bot.setNickname).toHaveBeenLastCalledWith(GUILD_A, null);
    expect(bot.setNickname).toHaveBeenCalledTimes(2);
  });

  it("turns Discord's 50013 on a nickname into a warning, not an error", async () => {
    const { storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria", nicknames: { [GUILD_A]: "Ari" } });
    const bot = fakeBot({
      user: { id: "900000000000000001", username: "Aria", avatar: null, banner: null },
      guilds: [{ guildId: GUILD_A, nickname: null, canChangeNickname: true }]
    });
    bot.setNickname.mockRejectedValueOnce({ status: 403, code: 50013, message: "Missing Permissions" });
    const sync = service(storage, { aria: bot });
    await sync.syncBot("aria");
    const file = JSON.parse(await readFile(path.join(storage.dataRoot, "app", "discord-profile-sync.json"), "utf8"));
    expect(file.bots.aria.lastError).toBeUndefined();
    expect(file.bots.aria.warnings).toEqual([expect.objectContaining({ code: "missing_permission", guildId: GUILD_A })]);
  });

  it("never touches a shared bot, an unlinked waifu or the House bot", async () => {
    const { storage } = await root();
    await writeBots(storage, ["shared", "house"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "shared", username: "Ari" });
    await writeWaifu(storage, { id: "mina", name: "Mina", botId: "shared", username: "Mina" });
    await writeWaifu(storage, { id: "kai", name: "Kai" });
    await writeWaifu(storage, { id: "noa", name: "Noa", botId: "house", username: "Noa" });
    const shared = fakeBot();
    const house = fakeBot();
    const sync = service(storage, { shared, house });
    await sync.syncAll();
    await sync.syncWaifu("kai");
    await sync.syncWaifu("noa");
    expect(shared.editUser).not.toHaveBeenCalled();
    expect(house.editUser).not.toHaveBeenCalled();
    expect(house.editApplicationDescription).not.toHaveBeenCalled();
    expect((await sync.status("aria"))?.state).toBe("shared_bot");
    expect((await sync.status("kai"))?.state).toBe("no_bot");
    expect((await sync.status("noa"))?.state).toBe("bot_missing");
  });

  it("reports offline (with what is waiting) when no runtime is connected", async () => {
    const { storage } = await root();
    await writeBots(storage, ["aria"]);
    await writeWaifu(storage, { id: "aria", name: "Aria", botId: "aria" });
    const status = await discordProfileStatus({ storage, waifuId: "aria" });
    expect(status).toMatchObject({ state: "offline", botId: "aria", username: { value: "Aria", source: "displayName" }, bio: null });
    expect(await discordProfileStatus({ storage, waifuId: "nobody" })).toBeUndefined();
  });
});

describe("DiscordJsGateway profile access", () => {
  function bot(id: string): DiscordBotConfig {
    return { id, displayName: id, token: `${id}-token`, enabled: true };
  }

  it("hands out profile handles for waifu bots only, never the House bot", async () => {
    const created = new Map<string, Client>();
    const options = new Map<string, unknown>();
    const factory: NonNullable<DiscordJsGatewayOptions["createClient"]> = ({ bot: config, options: clientOptions }) => {
      const client = new Client(clientOptions);
      created.set(config.id, client);
      options.set(config.id, clientOptions);
      const userId = config.id === "copy" ? "1000" : config.id === "house" ? "1000" : "2000";
      (client as unknown as { login: () => Promise<string> }).login = async () => {
        (client as unknown as { user: unknown }).user = { id: userId, username: config.id, avatar: null, banner: null, edit: vi.fn() };
        queueMicrotask(() => client.emit(Events.ClientReady, client as Client<true>));
        return "token";
      };
      (client as unknown as { destroy: () => Promise<void> }).destroy = async () => undefined;
      return client;
    };
    const ready: string[] = [];
    const gateway = new DiscordJsGateway({
      house: bot("house"),
      waifus: [bot("aria"), bot("copy")],
      createClient: factory,
      applicationOwners: { isOwner: async () => true }
    });
    gateway.onWaifuBotReady((event) => ready.push(event.botId));
    try {
      await gateway.connect();
      expect(ready.sort()).toEqual(["aria", "copy"]);
      expect(gateway.connectedWaifuBotIds().sort()).toEqual(["aria", "copy"]);
      expect(gateway.waifuBotProfile("house")).toBeUndefined();
      // Same Discord account as the House bot behind a waifu entry: never edited.
      expect(gateway.waifuBotProfile("copy")).toBeUndefined();
      expect(gateway.waifuBotProfile("aria")?.user()).toMatchObject({ id: "2000", username: "aria" });
      expect(gateway.waifuBotProfile("unknown")).toBeUndefined();
      // Waifu bots reject rate-limited profile edits (retried later); the House bot keeps the default.
      expect((options.get("aria") as { rest?: { rejectOnRateLimit?: unknown } }).rest?.rejectOnRateLimit).toBe(profileEditRateLimitFilter);
      expect((options.get("house") as { rest?: unknown }).rest).toBeUndefined();
    } finally {
      await gateway.disconnect();
    }
  });

  it("rejects only profile edits on rate limit", () => {
    expect(profileEditRateLimitFilter({ method: "PATCH", route: "/users/@me" })).toBe(true);
    expect(profileEditRateLimitFilter({ method: "PATCH", route: "/applications/@me" })).toBe(true);
    expect(profileEditRateLimitFilter({ method: "POST", route: "/users/@me/channels" })).toBe(false);
    expect(profileEditRateLimitFilter({ method: "PATCH", route: "/guilds/:id/members/@me" })).toBe(false);
  });
});

describe("profile API", () => {
  async function app() {
    const { root: dir, storage } = await root();
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "0.1.0",
      port: 3888,
      dataRoot: dir,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const syncWaifu = vi.fn(async () => undefined);
    const syncDiscordProfile = vi.fn();
    const server = await createApiServer({
      dataRoot: dir,
      runtime,
      storage,
      castRuntime: {
        syncDiscordProfile,
        reconcileDmIntents: async () => ({ relogged: [] }),
        discordProfiles: { syncWaifu, status: (waifuId: string) => discordProfileStatus({ storage, waifuId }) }
      } as never
    });
    return { server, storage, syncWaifu, syncDiscordProfile };
  }

  it("serves the status, syncs on writes and uploads, and checks image bytes", async () => {
    const { server, storage, syncWaifu, syncDiscordProfile } = await app();
    try {
      await writeBots(storage, ["aria"]);
      expect((await server.inject({ method: "POST", url: "/api/waifus", payload: { id: "aria", name: "Aria", displayName: "Aria", botId: "aria" } })).statusCode).toBe(201);
      const bad = await server.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: 0, username: "discord-aria" } });
      expect(bad.statusCode).toBe(400);
      const saved = await server.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: 0, username: "Ari", bio: "Hi.", nicknames: { [GUILD_A]: "Ari" } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ username: "Ari", bio: "Hi.", nicknames: { [GUILD_A]: "Ari" } });
      expect(syncDiscordProfile).toHaveBeenCalledWith("aria");
      // Her ~/profile.json follows the dashboard edit (§17.1).
      const file = JSON.parse(await readFile(path.join(storage.dataRoot, "user", "waifus", "aria", "home", "profile.json"), "utf8"));
      expect(file).toEqual({ name: "Aria", username: "Ari", bio: "Hi.", nicknames: { [GUILD_A]: "Ari" } });
      const cleared = await server.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: saved.json().revision, bio: null } });
      expect(cleared.json().bio).toBeUndefined();
      expect(cleared.json().username).toBe("Ari");

      const lying = await server.inject({ method: "POST", url: "/api/waifus/aria/assets/pfp", headers: { "content-type": "image/png" }, payload: GIF });
      expect(lying.statusCode).toBe(400);
      expect(lying.json().message).toContain("image/gif");
      // Bigger than Fastify's default 1 MiB body limit.
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      const upload = await server.inject({ method: "POST", url: "/api/waifus/aria/assets/pfp", headers: { "content-type": "image/png" }, payload: big });
      expect(upload.statusCode).toBe(201);
      // Create, two PUTs and the upload.
      expect(syncDiscordProfile).toHaveBeenCalledTimes(4);

      const status = await server.inject({ method: "GET", url: "/api/waifus/aria/discord-profile" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ state: "offline", username: { value: "Ari", source: "username" }, images: { avatar: { contentType: "image/png" }, banner: null } });
      const synced = await server.inject({ method: "POST", url: "/api/waifus/aria/discord-profile/sync" });
      expect(synced.statusCode).toBe(200);
      expect(syncWaifu).toHaveBeenCalledWith("aria");
      expect((await server.inject({ method: "GET", url: "/api/waifus/nobody/discord-profile" })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("dashboard profile section", () => {
  it("words the sync state, including the rate-limit wait", async () => {
    const { profileStatusLine, imageLabel } = await import("../src/frontend/utils/discordProfile.js");
    const now = Date.parse("2026-10-25T12:00:00Z");
    const base = {
      waifuId: "aria",
      botId: "aria",
      username: { value: "Ari", source: "username" as const },
      bio: null,
      nicknames: {},
      images: { avatar: null, banner: null },
      pendingFields: [],
      retryAfterByField: {},
      warnings: []
    };
    expect(profileStatusLine({ ...base, state: "synced" }, now)).toMatchObject({ tone: "ok", text: expect.stringContaining("Synced") });
    const until = new Date(now + 34 * 60_000).toISOString();
    expect(
      profileStatusLine({ ...base, state: "rate_limited", pendingFields: ["username"], retryAfter: until, retryAfterByField: { username: until } }, now).text
    ).toBe("Username change waiting for Discord's rate limit (try again in 34 min). The app retries on its own.");
    expect(profileStatusLine({ ...base, state: "shared_bot" }, now).text).toContain("leaves its profile alone");
    expect(imageLabel({ contentType: "image/png", bytes: 120 * 1024, synced: true })).toBe("PNG · 120 KB · on Discord");
  });

  it("sends null when a profile field is cleared, and checks it before saving", async () => {
    const { waifuPatch, waifuProblems } = await import("../src/frontend/screens/castEdit.js");
    const remote = WaifuConfigSchema.parse({ ...createRevisionedBase(), id: "aria", name: "Aria", displayName: "Aria", username: "Ari", bio: "Hi." });
    const draft = { ...remote, username: undefined, bio: "Hello." };
    expect(waifuPatch(remote, draft)).toEqual({ revision: 0, username: null, bio: "Hello." });
    expect(waifuProblems({ username: "discord" })).toEqual(['A Discord username cannot contain "discord".']);
    expect(waifuProblems({ nicknames: { x: "Ari" } })[0]).toContain("server id");
  });
});
