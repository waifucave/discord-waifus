// Images in a life (Living cast spec §5.3, §6.2, §12): an image shows inline only at its first
// occurrence in the epoch, within the per-result, per-epoch count and byte caps; a re-read renders it
// as text; a pinned image that can no longer be fetched forces a compaction; and a forget purges the
// cached bytes the life fetched through the real renderer and image fetcher.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordImageFetcher } from "../src/discord/attachments.js";
import { readLifeLog, readLifeState } from "../src/life/lifeStore.js";
import { selfAuthorIds } from "../src/life/people.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext } from "../src/life/tools/types.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { FakeImageFetcher, quietLogger } from "./contextFixtures.js";
import { textTurn } from "./modelFakes.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, ROOM, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const image = (id: string, size = 2048): RawDiscordMessage["attachments"][number] => ({
  id,
  url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${id}/cake-${id}.png`,
  filename: `cake-${id}.png`,
  contentType: "image/png",
  size,
  width: 64,
  height: 64
});

async function ctxFor(w: LifeWorld): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "aria");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps)
  };
}

const kinds = (content: unknown) => (Array.isArray(content) ? content.map((block: { type: string }) => block.type) : ["text"]);
const textOf = (content: unknown) =>
  typeof content === "string" ? content : (content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join("\n");

describe("images in read_messages (§6.2)", () => {
  it("inline at first occurrence within the caps; every later occurrence is text", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher },
      config: (config) => ({ ...config, life: { ...config.life, maxInlineImagesPerEpoch: 5 } })
    });
    const ctx = await ctxFor(w);
    expect(ctx.route.imageInput).toBe(true);
    for (let index = 1; index <= 6; index += 1) w.discord.post(ROOM, `cake ${index}`, { attachments: [image(String(9000 + index))] });
    const first = await lifeTool("read_messages")!.run({ place: "bake-club/#general" }, ctx);
    // At most 4 inline per result.
    expect(kinds(first.content).filter((kind) => kind === "life_image")).toHaveLength(4);
    expect(textOf(first.content).match(/\[image\]/gu)).toHaveLength(2);
    // Re-read: every image was shown this epoch, so all are text now.
    const again = await lifeTool("read_messages")!.run({ place: "bake-club/#general" }, ctx);
    expect(kinds(again.content).filter((kind) => kind === "life_image")).toHaveLength(0);
    expect(textOf(again.content).match(/\[image\]/gu)).toHaveLength(6);
    // The epoch's count cap (5): one more new image inline, then text.
    w.discord.post(ROOM, "two more", { attachments: [image("9101"), image("9102")] });
    const third = await lifeTool("read_messages")!.run({ place: "bake-club/#general", limit: 1 }, ctx);
    expect(kinds(third.content).filter((kind) => kind === "life_image")).toHaveLength(1);
    const state = await readLifeState(w.storage, "aria");
    expect(state.inlineImageCount).toBe(5);
  });

  it("the epoch's byte cap turns the next image into text", async () => {
    const fetcher = new FakeImageFetcher();
    fetcher.sizes.set("att:9201", 3_000_000);
    fetcher.sizes.set("att:9202", 3_000_000);
    const w = await lifeWorld(roots, {
      options: { images: fetcher },
      config: (config) => ({ ...config, life: { ...config.life, maxInlineImageBytesPerEpoch: 4_000_000 } })
    });
    w.discord.post(ROOM, "big one", { attachments: [image("9201", 3_000_000)] });
    w.discord.post(ROOM, "another big one", { attachments: [image("9202", 3_000_000)] });
    const result = await lifeTool("read_messages")!.run({ place: "bake-club/#general" }, await ctxFor(w));
    expect(kinds(result.content).filter((kind) => kind === "life_image")).toHaveLength(1);
    expect(textOf(result.content)).toContain("[image]");
  });
});

describe("pinned images (§5.3)", () => {
  it("a pinned image that can no longer be fetched ends the epoch: the turn continues after a compaction; the kept image keeps its OCR text", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher, ocr: { cachedText: async (ref) => (ref.key === "att:9301" ? "a chocolate cake with candles" : undefined) } },
      scripts: script(
        toolTurn([{ name: "read_messages", input: { place: "bake-club/#general" } }]),
        textTurn("cute cake"),
        // The unsent-reply check of that direct wake.
        textTurn("(nothing to send)"),
        // Next wake: the request cannot be built (the image is gone): compaction first.
        textTurn("Earlier: Kevin showed me a cake picture."),
        textTurn("ok")
      )
    });
    const posted = w.discord.post(ROOM, `<@${ARIA_BOT}> look at my cake`, { attachments: [image("9301")], mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: posted.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: posted });
    await w.cast.settle();
    await w.cast.life("aria").runNow();
    const before = await readLifeState(w.storage, "aria");
    expect(before.inlineImageCount).toBe(1);
    // The image's bytes are gone from the cache and from Discord.
    const key = before.shownImageKeys[0]!;
    fetcher.failKeys.set(key, "http_error");
    const again = w.discord.post(ROOM, `<@${ARIA_BOT}> did you see it?`, { mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: again.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: again });
    await w.cast.settle();
    await w.cast.life("aria").runNow();
    const after = await readLifeState(w.storage, "aria");
    expect(after.epoch).toBe(2);
    expect(after.summary).toBe("Earlier: Kevin showed me a cake picture.");
    const summaryCall = w.anthropic.calls[3]!.request;
    expect(JSON.stringify(summaryCall.messages[summaryCall.messages.length - 1])).toContain("Time to summarise");
    // The kept turn's image is text in the new epoch: no image block is sent any more.
    const lastCall = w.anthropic.calls[4]!.request;
    expect(JSON.stringify(lastCall.messages)).not.toContain("\"type\":\"image\"");
    const log = await readLifeLog(w.storage, "aria", 2);
    // Kept as a text-mode image block (its inline budget starts at zero in the new epoch).
    expect(JSON.stringify(log)).toContain('"type":"life_image"');
    expect(JSON.stringify(log)).not.toContain('"mode":"inline"');
    // Frozen with its OCR text, not a bare placeholder.
    expect(JSON.stringify(log)).toContain('"mode":{"text":"[image: a chocolate cake with candles]"}');
    expect(JSON.stringify(lastCall.messages)).toContain("[image: a chocolate cake with candles]");
  });
});

describe("forget purges what the life fetched (real renderer and fetcher)", () => {
  it("a DM image read by her is indexed under the conversation and purged by a DM forget", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const fetcher = new DiscordImageFetcher({
      dataRoot: "",
      logger: quietLogger() as never,
      fetch: (async () => new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } })) as typeof fetch
    });
    const w = await lifeWorld(roots, { options: {} });
    // The fetcher writes under this world's data root.
    (fetcher as unknown as { options: { dataRoot: string } }).options.dataRoot = w.root;
    (w.cast.deps as { images?: unknown }).images = fetcher;
    const message = w.discord.post(dmOf("aria"), "my cake!", { attachments: [{ ...image("9401"), url: `https://cdn.discordapp.com/attachments/1/9401/cake-9401.png` }] });
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    w.cast.intake.close();
    const read = await lifeTool("read_messages")!.run({ place: "dm/kevin" }, await ctxFor(w));
    expect(kinds(read.content)).toContain("life_image");
    const conversation = path.join(w.root, "user/conversations", `dm_${KEVIN}_aria`);
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(conversation, "images.json"), "utf8")).keys).toEqual(["att:9401"]);
    const cacheDir = path.join(w.root, "app/cache/images");
    expect((await readdir(cacheDir, { recursive: true })).some((entry) => String(entry).length > 0)).toBe(true);
    const result = await dmForget(w.storage, { userId: KEVIN, waifuId: "aria", scope: "conversation" });
    expect(result.deleted.cachedImages).toBe(1);
    const left = (await readdir(cacheDir, { recursive: true }).catch(() => [])).filter((entry) => /\.(bin|png|img)$|^[0-9a-f]{16,}/u.test(String(path.basename(String(entry)))));
    expect(left).toEqual([]);
    await expect(readdir(conversation)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
