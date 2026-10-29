// Her Discord profile as a file in her home (Living cast §17.1): `~/life/profile.json` holds her
// username, bio and server nicknames, checked on every write and kept equal to her config both ways.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeStoreFor, rewriteProfileFile } from "../src/life/home/index.js";
import { checkProfileText, profileFileText } from "../src/life/home/profileFile.js";
import { selfAuthorIds } from "../src/life/people.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import { profileSavedNote } from "../src/life/tools/profileNote.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import type { BotProfileHandle } from "../src/discord/profileSync.js";
import { closeWorlds, GUILD, lifeWorld, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, readFile as readFile_, replaceFilePatch, updateFilePatch } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function ctxFor(w: LifeWorld, o: { mode?: "life" | "session" } = {}): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps),
    ...(o.mode ? { mode: o.mode } : {})
  };
}

const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, ctx);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
const profilePath = (w: LifeWorld) => path.join(w.root, "user", "waifus", "ella", "home", "life", "profile.json");
const readProfile = async (w: LifeWorld) => JSON.parse(await readFile(profilePath(w), "utf8")) as Record<string, unknown>;

async function world(o: { sync?: { syncWaifu: (id: string) => Promise<void> } } = {}) {
  const w = await lifeWorld(roots, { ...(o.sync ? { options: { profileSync: o.sync } } : {}) });
  await homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella")).writeProfileFromConfig();
  return w;
}

describe("profile.json (§17.1)", () => {
  it("is written from her config with servers named as her places name them, and kept while it agrees", async () => {
    const w = await world();
    expect(await readProfile(w)).toEqual({ name: "Ella", username: null, bio: null, nicknames: {} });
    // Her own layout survives when it says the same.
    const mine = '{"name": "Ella", "username": null, "bio": null, "nicknames": {}}\n';
    await writeFile(profilePath(w), mine);
    expect(await rewriteProfileFile(w.storage, "ella")).toBe(false);
    expect(await readFile(profilePath(w), "utf8")).toBe(mine);
    // A dashboard edit rewrites it.
    const waifu = await readWaifu(w.storage, "ella");
    await w.storage.writeJson("waifu:ella", "user/waifus/ella/waifu.json", WaifuConfigSchema, { ...waifu, username: "Ari", nicknames: { [GUILD]: "Ari the Baker" } });
    expect(await rewriteProfileFile(w.storage, "ella")).toBe(true);
    expect(await readProfile(w)).toEqual({ name: "Ella", username: "Ari", bio: null, nicknames: { "bake-club": "Ari the Baker" } });
  });

  it("her Edit becomes her config, starts the sync and tells her what happens", async () => {
    const sync = { syncWaifu: vi.fn(async () => undefined) };
    const w = await world({ sync });
    const ctx = await ctxFor(w);
    expect(text(await applyPatch(ctx, addFilePatch("~/life/profile.json", "{}")))).toMatch(/Add File: ~\/life\/profile\.json already exists/u);
    const content = JSON.stringify({ name: "Ella", username: "Ari ✨", bio: "Sunny baker. Ask me about lemon tarts.", nicknames: { "bake-club": "Ari" } }, null, 2);
    const result = text(await applyPatch(ctx, replaceFilePatch("~/life/profile.json", content)));
    // The fake Discord has no bot of hers online: Discord shows it later.
    expect(result).toBe("Updated: D ~/life/profile.json, A ~/life/profile.json\nprofile.json: saved; Discord shows it once you're back online");
    expect(sync.syncWaifu).toHaveBeenCalledWith("ella");
    expect(await readWaifu(w.storage, "ella")).toMatchObject({ name: "Ella", username: "Ari ✨", bio: "Sunny baker. Ask me about lemon tarts.", nicknames: { [GUILD]: "Ari" } });
    // A one-line change too; the same values again (another layout) change nothing.
    expect(text(await applyPatch(ctx, updateFilePatch("~/life/profile.json", ['  "bio": "Sunny baker. Ask me about lemon tarts.",', '  "bio": "Sunny baker. Ask me about brownies.",'])))).toMatch(/profile\.json: saved/u);
    expect((await readWaifu(w.storage, "ella")).bio).toBe("Sunny baker. Ask me about brownies.");
    const same = JSON.stringify(JSON.parse(await readFile(profilePath(w), "utf8")));
    expect(text(await applyPatch(ctx, replaceFilePatch("~/life/profile.json", same)))).toMatch(/profile\.json: your profile is the same as before/u);
  });

  it("refuses invalid edits with a clear error and changes nothing", async () => {
    const w = await world();
    const ctx = await ctxFor(w);
    const before = await readFile(profilePath(w), "utf8");
    const attempt = (content: string) => applyPatch(ctx, replaceFilePatch("~/life/profile.json", content));
    const cases: Array<[string, RegExp]> = [
      ['{"name": "Ella", "username": "discord queen"}', /username: A Discord username cannot contain "discord"/u],
      ['{"name": "Ella", "username": "A"}', /2 to 32 characters/u],
      [JSON.stringify({ name: "Ella", bio: "x".repeat(401) }), /bio has 401 characters; at most 400/u],
      ['{"name": "Ella", "nicknames": {"bake-club": "' + "n".repeat(33) + '"}}', /1 to 32 characters/u],
      ['{"name": "Ella", "nicknames": {"knitting-circle": "Ari"}}', /no server called "knitting-circle".*like bake-club/u],
      ['{"name": "Ariadne"}', /your name is Ella and can't be changed here/u],
      ['{"name": "Ella", "mood": "happy"}', /unknown field "mood"/u],
      ['{\n  "name": "Ella",\n  "bio": "hi",\n}', /profile\.json line 4, column 1/u],
      ["[]", /must be one JSON object/u]
    ];
    for (const [content, error] of cases) {
      const result = await attempt(content);
      expect(result.isError, content).toBe(true);
      expect(text(result), content).toMatch(error);
    }
    expect(await readFile(profilePath(w), "utf8")).toBe(before);
    expect((await readWaifu(w.storage, "ella")).username).toBeUndefined();
    // A server id works as a key; it can't be deleted.
    await attempt(JSON.stringify({ name: "Ella", nicknames: { [GUILD]: "Ari" } }));
    expect((await readWaifu(w.storage, "ella")).nicknames).toEqual({ [GUILD]: "Ari" });
    const rm = await run("Bash", { command: "rm ~/life/profile.json" }, ctx);
    expect(text(rm)).toMatch(/profile\.json can't be deleted/u);
  });

  it("a stale patch after a dashboard edit no longer matches; the retired Write still says 'changed since you read it'", async () => {
    const w = await world();
    const ctx = await ctxFor(w);
    await readFile_(ctx, "~/life/profile.json");
    const waifu = await readWaifu(w.storage, "ella");
    await w.storage.writeJson("waifu:ella", "user/waifus/ella/waifu.json", WaifuConfigSchema, { ...waifu, bio: "Set from the dashboard." });
    await rewriteProfileFile(w.storage, "ella");
    const patched = await applyPatch(ctx, updateFilePatch("~/life/profile.json", ['  "bio": null,', '  "bio": "mine",']));
    expect(text(patched)).toMatch(/apply_patch: Failed to find expected lines in ~\/life\/profile\.json/u);
    const result = await run("Write", { file_path: "~/life/profile.json", content: '{"name": "Ella", "bio": "mine"}' }, ctx);
    expect(text(result)).toBe("error: profile.json changed since you read it (your profile was changed for you); Read it again");
    expect((await readWaifu(w.storage, "ella")).bio).toBe("Set from the dashboard.");
  });

  it("Bash may change it; tidying (maintenance) never does", async () => {
    const w = await world();
    const life = await ctxFor(w);
    const bash = await run("Bash", { command: `printf '%s' '{"name":"Ella","bio":"from bash"}' > ~/life/profile.json` }, life);
    expect(text(bash)).toMatch(/profile\.json: saved/u);
    expect((await readWaifu(w.storage, "ella")).bio).toBe("from bash");
    const tidy = await ctxFor(w, { mode: "session" });
    expect(text(await applyPatch(tidy, replaceFilePatch("~/life/profile.json", '{"name":"Ella"}')))).toMatch(/isn't changed while tidying/u);
    expect(text(await applyPatch(tidy, updateFilePatch("~/life/profile.json", ["from bash", "tidied"])))).toMatch(/isn't changed while tidying/u);
    expect(text(await run("Bash", { command: "sed -i 's/from bash/tidied/' ~/life/profile.json" }, tidy))).toMatch(/isn't changed while tidying/u);
    expect((await readWaifu(w.storage, "ella")).bio).toBe("from bash");
  });

  it("is never attached to a message", async () => {
    const w = await world();
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    expect(await store.isPrivateFile(store.life("profile.json"))).toBe(true);
  });

  it("says a username change is already waiting for Discord's rate limit, so she does not rename again", async () => {
    const w = await world();
    const waifu = await readWaifu(w.storage, "ella");
    await w.storage.writeJson("waifu:ella", "user/waifus/ella/waifu.json", WaifuConfigSchema, { ...waifu, username: "Ari" });
    const handle: BotProfileHandle = {
      user: () => ({ id: "900000000000000001", username: "Ella", avatar: null, banner: null }),
      editUser: vi.fn(),
      fetchApplicationDescription: vi.fn(async () => ""),
      editApplicationDescription: vi.fn(),
      guilds: () => [],
      setNickname: vi.fn()
    };
    const retry = new Date(w.clock.ms + 34 * 60_000).toISOString();
    await mkdir(path.join(w.root, "app"), { recursive: true });
    await writeFile(
      path.join(w.root, "app", "discord-profile-sync.json"),
      JSON.stringify({ bots: { "ella-bot": { waifuId: "ella", discordUserId: "900000000000000001", pendingFields: ["username"], retryAfter: { username: retry } } } })
    );
    const deps = { ...w.cast.deps, discord: () => ({ ...w.discord, waifuBotProfile: () => handle }) as never };
    const note = await profileSavedNote(deps, "ella", true);
    expect(note).toBe("saved; Discord allows only about 2 username changes an hour, so your new username shows in ~34 min; it's already on its way, don't change it again before then");
    expect(await profileSavedNote({ ...deps, discord: () => ({ waifuBotProfile: () => ({ ...handle, user: () => ({ ...handle.user(), username: "Old" }) }) }) as never }, "ella", true)).toMatch(/username shows in ~34 min/u);
  });

  it("checks keys and renders servers it can't name by id", () => {
    const servers = [{ guildId: GUILD, name: "Bake Club" }];
    expect(checkProfileText('{"nicknames": {"Bake Club": "Ari"}}', { name: "Ella", servers })).toEqual({ ok: true, fields: { nicknames: { [GUILD]: "Ari" } } });
    expect(checkProfileText('{"nicknames": {"bake-club/#general": "Ari"}}', { name: "Ella", servers })).toEqual({ ok: true, fields: { nicknames: { [GUILD]: "Ari" } } });
    expect(JSON.parse(profileFileText({ name: "Ella", nicknames: { "999999999999999999": "Ari" } }, servers)).nicknames).toEqual({ "999999999999999999": "Ari" });
  });
});
