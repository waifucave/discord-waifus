// Server emojis in ~/life/places.md (Living cast spec §28): one line per server with usable emojis,
// at most 50, most used over the server's last 30 days of transcripts first, then by name; the
// usage order is recounted at most hourly, so a refresh with nothing new writes nothing.
import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuildDirectory } from "../src/discord/guildDirectory.js";
import { refreshPlacesFile } from "../src/life/home/index.js";
import { EMOJI_USAGE_TTL_MS, emojiListText } from "../src/life/home/serverEmojis.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ServerConfigSchema, type GuildEmojiCacheEntry } from "../src/shared/schemas/domain.js";
import { CHANNEL_2, closeWorlds, GUILD, herFile, lifeWorld, seedTranscript, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const ELLA = { id: "ella", name: "Ella" };
const OTHER_GUILD = "100000000000000777";
const OTHER_CHANNEL = "200000000000000777";

let nextId = 1;
const emoji = (name: string, o: Partial<GuildEmojiCacheEntry> = {}): GuildEmojiCacheEntry => ({
  id: String(500000000000000000n + BigInt(nextId++)),
  name,
  animated: false,
  available: true,
  roles: [],
  fetchedAt: "2026-10-24T00:00:00.000Z",
  ...o
});

const directoryOf = (w: LifeWorld) => w.cast.deps.directory as GuildDirectory;

/** Adds the server's emojis as gateway events would (files loaded first, so the events apply at once). */
async function addEmojis(w: LifeWorld, guildId: string, emojis: GuildEmojiCacheEntry[]): Promise<void> {
  const directory = directoryOf(w);
  await directory.availableEmojis(guildId);
  for (const entry of emojis) directory.handle({ type: "emojiUpsert", guildId, emoji: entry });
}

const placesOf = async (w: LifeWorld) => (await herFile(w, "ella", "home/life/places.md"))!;
const emojiLine = (text: string, slug = "bake-club") => text.split("\n").find((line) => line.startsWith(`- ${slug} (`) && line.includes(": :"));

describe("places.md server emojis (§28)", () => {
  it("lists the available emojis most used first, then by name; animated like the others; none = no line", async () => {
    const w = await lifeWorld(roots);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    expect(await placesOf(w)).not.toContain("Server emojis:");

    await seedTranscript(w, [
      { text: "lol :kekw: :kekw:" },
      { text: "<3 :blobheart:" },
      { text: "too old :pepe_cry: :pepe_cry: :pepe_cry:", minutesAgo: 31 * 24 * 60 },
      { text: ":kekw: again" }
    ]);
    await seedTranscript(w, [{ text: "in recipes :blobheart: :blobheart: :blobheart: :wave:" }], { conversation: { kind: "guild", guildId: GUILD, channelId: CHANNEL_2 } });
    await addEmojis(w, GUILD, [emoji("pepe_cry"), emoji("kekw"), emoji("Zebra"), emoji("blobheart"), emoji("party", { animated: true }), emoji("gone", { available: false }), emoji("apple")]);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    const text = await placesOf(w);
    // blobheart 4 (two channels), kekw 3, then by name; the 31-day-old line and the unavailable one don't count.
    expect(text).toContain("Server emojis:\n- bake-club (Bake Club): :blobheart: :kekw: :apple: :party: :pepe_cry: :Zebra:\n\nPrivate chats");
    expect(text).not.toContain(":gone:");
  });

  it("caps at 50 with (+N more), one line per server, a server without emojis has none", async () => {
    const w = await lifeWorld(roots);
    await w.storage.writeJson(
      `server:${OTHER_GUILD}`,
      `user/servers/${OTHER_GUILD}/server.json`,
      ServerConfigSchema,
      ServerConfigSchema.parse({ ...createRevisionedBase(), guildId: OTHER_GUILD, name: "Quiet Place", channels: { [OTHER_CHANNEL]: { channelId: OTHER_CHANNEL, name: "lobby", enabledWaifuIds: ["ella"] } } })
    );
    const many = Array.from({ length: 53 }, (_, index) => emoji(`e${String(index).padStart(2, "0")}`));
    await seedTranscript(w, [{ text: ":e52: :e52: :e51:" }]);
    await addEmojis(w, GUILD, many);
    await addEmojis(w, OTHER_GUILD, []);
    await refreshPlacesFile(w.cast.deps, ELLA);
    const line = emojiLine(await placesOf(w))!;
    const shown = line.match(/:e\d\d:/gu)!;
    expect(shown).toHaveLength(50);
    expect(shown.slice(0, 3)).toEqual([":e52:", ":e51:", ":e00:"]);
    expect(line.endsWith(":e47: (+3 more)")).toBe(true);
    expect(await placesOf(w)).not.toContain("quiet-place (");

    await addEmojis(w, OTHER_GUILD, [emoji("hush")]);
    await refreshPlacesFile(w.cast.deps, ELLA);
    expect(emojiLine(await placesOf(w), "quiet-place")).toBe("- quiet-place (Quiet Place): :hush:");
  });

  it("an added, removed or renamed emoji shows at the next refresh; nothing changed = nothing written", async () => {
    const w = await lifeWorld(roots);
    const kekw = emoji("kekw");
    const wave = emoji("wave");
    await addEmojis(w, GUILD, [kekw, wave]);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    const file = path.join(w.root, "user", "waifus", "ella", "home", "life", "places.md");
    const before = await stat(file);
    // Two refreshes with no change write nothing (file untouched).
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(false);
    w.clock.advance(60_000);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(false);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);

    const directory = directoryOf(w);
    directory.handle({ type: "emojiUpsert", guildId: GUILD, emoji: emoji("blob") });
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    expect(emojiLine(await placesOf(w))).toBe("- bake-club (Bake Club): :blob: :kekw: :wave:");
    directory.handle({ type: "emojiUpsert", guildId: GUILD, emoji: { ...kekw, name: "lol" } });
    directory.handle({ type: "emojiDelete", guildId: GUILD, emojiId: wave.id });
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    expect(emojiLine(await placesOf(w))).toBe("- bake-club (Bake Club): :blob: :lol:");
  });

  it("recounts usage at most hourly: new use reorders the line only after the hour", async () => {
    const w = await lifeWorld(roots);
    await addEmojis(w, GUILD, [emoji("apple"), emoji("zest")]);
    await refreshPlacesFile(w.cast.deps, ELLA);
    expect(emojiLine(await placesOf(w))).toBe("- bake-club (Bake Club): :apple: :zest:");
    await seedTranscript(w, [{ text: ":zest: :zest:" }]);
    w.clock.advance(EMOJI_USAGE_TTL_MS - 60_000);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(false);
    w.clock.advance(60_000);
    expect(await refreshPlacesFile(w.cast.deps, ELLA)).toBe(true);
    expect(emojiLine(await placesOf(w))).toBe("- bake-club (Bake Club): :zest: :apple:");
  });

  it("emojiListText: one entry per name, unavailable left out, undefined when none", () => {
    expect(emojiListText([], new Map())).toBeUndefined();
    expect(emojiListText([{ name: "a", available: false }], new Map())).toBeUndefined();
    expect(emojiListText([{ name: "b", available: true }, { name: "a", available: true }, { name: "b", available: true }], new Map())).toBe(":a: :b:");
    expect(emojiListText([{ name: "a", available: true }, { name: "b", available: true }, { name: "c", available: true }], new Map([["c", 1]]), 2)).toBe(":c: :a: (+1 more)");
  });
});
