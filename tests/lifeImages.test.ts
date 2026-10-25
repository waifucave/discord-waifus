// Images in a life (Living cast spec §5.3, §12, §16.3.3): ReadMessages saves pictures in her /tmp
// and never inlines them; she looks with Read. An image shows inline only at its first occurrence
// in the epoch, within the per-epoch count and byte caps, on a route with image input; otherwise
// (or over the caps) it is its OCR text. The bytes are cached under their hash, so replay never
// depends on the file; a pinned image that can no longer be fetched forces a compaction; and a
// forget purges the cached bytes of a DM picture she read, through the real fetcher.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, ROOM, script, tinyPng, toolTurn, type LifeWorld } from "./lifeFixtures.js";
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
const modes = (content: unknown) => (Array.isArray(content) ? content.filter((block: { type: string }) => block.type === "life_image").map((block: { mode: unknown }) => block.mode) : []);
const textOf = (content: unknown) =>
  typeof content === "string" ? content : (content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join("\n");

/** Pictures in her /tmp, each a different PNG. */
async function pictures(w: LifeWorld, count: number, size = 4): Promise<string[]> {
  const dir = path.join(w.root, "user/waifus/aria/tmp/pics");
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(dir, `p${size}-${index}.png`), tinyPng(size + index, size));
    paths.push(`/tmp/pics/p${size}-${index}.png`);
  }
  return paths;
}

describe("ReadMessages never inlines images (§16.3.1)", () => {
  it("a picture in a conversation is a path line; she looks with Read", async () => {
    const fetcher = new FakeImageFetcher();
    fetcher.files.set("att:9001", tinyPng());
    const w = await lifeWorld(roots, { options: { images: fetcher } });
    w.discord.post(ROOM, "cake!", { attachments: [image("9001")] });
    const ctx = await ctxFor(w);
    const read = await lifeTool("ReadMessages")!.run({ place: "bake-club/#general" }, ctx);
    expect(kinds(read.content)).toEqual(["text"]);
    const line = /\[image: (\/tmp\/bake-club\/general\/[0-9a-z]+-cake-9001\.png)\]/u.exec(textOf(read.content));
    expect(line).not.toBeNull();
    const look = await lifeTool("Read")!.run({ file_path: line![1] }, ctx);
    expect(kinds(look.content)).toEqual(["text", "life_image"]);
    expect(textOf(look.content)).toMatch(/^\/tmp\/bake-club\/general\/[0-9a-z]+-cake-9001\.png: image \(\d+ B\)$/u);
    expect(modes(look.content)).toEqual(["inline"]);
  });
});

describe("Read of an image (§16.3.3)", () => {
  it("inline at first occurrence within the epoch's count cap; every later look is text", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher, ocr: { cachedText: async () => "a lemon tart" } },
      config: (config) => ({ ...config, life: { ...config.life, maxInlineImagesPerEpoch: 2 } })
    });
    const ctx = await ctxFor(w);
    expect(ctx.route.imageInput).toBe(true);
    const [a, b, c] = await pictures(w, 3);
    expect(modes((await lifeTool("Read")!.run({ file_path: a }, ctx)).content)).toEqual(["inline"]);
    // A picture already shown this epoch is not shown again: she is told so, with its text.
    expect(modes((await lifeTool("Read")!.run({ file_path: a }, ctx)).content)).toEqual([{ text: "[image: you've already seen this picture; the text in it: a lemon tart]" }]);
    expect(modes((await lifeTool("Read")!.run({ file_path: b }, ctx)).content)).toEqual(["inline"]);
    // The epoch's count cap (2): the third image is its OCR text.
    expect(modes((await lifeTool("Read")!.run({ file_path: c }, ctx)).content)).toEqual([{ text: "[image: a lemon tart]" }]);
    const state = await readLifeState(w.storage, "aria");
    expect(state.inlineImageCount).toBe(2);
    expect(state.shownImageKeys).toHaveLength(3);
    // The bytes are in the image cache under their hash.
    expect([...fetcher.local.keys()].every((key) => /^file:[0-9a-f]{64}$/u.test(key))).toBe(true);
    expect(fetcher.local.size).toBe(3);
  });

  it("the epoch's byte cap turns the next image into text; a route without image input always gets text", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher, ocr: { cachedText: async () => undefined } },
      config: (config) => ({ ...config, life: { ...config.life, maxInlineImageBytesPerEpoch: 100 } })
    });
    const ctx = await ctxFor(w);
    const [a, b] = await pictures(w, 2, 6);
    expect(modes((await lifeTool("Read")!.run({ file_path: a }, ctx)).content)).toEqual(["inline"]);
    expect(modes((await lifeTool("Read")!.run({ file_path: b }, ctx)).content)).toEqual([{ text: "[image: no text found]" }]);
    const textOnly: ToolContext = { ...ctx, route: { ...ctx.route, imageInput: false } };
    const [fresh] = await pictures(w, 1, 9);
    expect(modes((await lifeTool("Read")!.run({ file_path: fresh }, textOnly)).content)).toEqual([{ text: "[image: no text found]" }]);
  });

  it("replay never depends on the file: after it expired, her next request still carries the picture", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher },
      scripts: script(
        toolTurn([{ name: "Read", input: { file_path: "/tmp/pics/p4-0.png" } }]),
        textTurn("cute"),
        textTurn("(nothing to send)"),
        textTurn("still cute"),
        textTurn("(nothing to send)")
      )
    });
    await pictures(w, 1);
    const wake = async (text: string) => {
      const posted = w.discord.post(ROOM, `<@${ARIA_BOT}> ${text}`, { mentions: { [ARIA_BOT]: "Aria" } });
      await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: posted.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: posted });
      await w.cast.settle();
      await w.cast.life("aria").runNow();
    };
    await wake("look at your picture");
    await rm(path.join(w.root, "user/waifus/aria/tmp/pics/p4-0.png"));
    await wake("still there?");
    expect((await readLifeState(w.storage, "aria")).epoch).toBe(1);
    const last = w.anthropic.calls[w.anthropic.calls.length - 1]!.request;
    expect(JSON.stringify(last.messages)).toContain('"type":"image"');
  });
});

describe("pinned images (§5.3)", () => {
  it("a pinned image that can no longer be fetched ends the epoch: the turn continues after a compaction; the kept image keeps its OCR text", async () => {
    const fetcher = new FakeImageFetcher();
    fetcher.files.set("att:9301", tinyPng(5, 5));
    const w = await lifeWorld(roots, {
      options: { images: fetcher, ocr: { cachedText: async (ref) => (ref.key.startsWith("file:") ? "a chocolate cake with candles" : undefined) } },
      scripts: script(
        toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "Read", input: { file_path: "/tmp/bake-club/general/a0-cake-9301.png" } }]),
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
    // The image's bytes are gone from the cache (and the file may expire from her /tmp).
    const key = before.shownImageKeys[0]!;
    expect(key).toMatch(/^file:/u);
    fetcher.local.delete(key);
    const again = w.discord.post(ROOM, `<@${ARIA_BOT}> did you see it?`, { mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: again.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: again });
    await w.cast.settle();
    await w.cast.life("aria").runNow();
    const after = await readLifeState(w.storage, "aria");
    expect(after.epoch).toBe(2);
    expect(after.summary).toBe("Earlier: Kevin showed me a cake picture.");
    const summaryCall = w.anthropic.calls[4]!.request;
    expect(JSON.stringify(summaryCall.messages[summaryCall.messages.length - 1])).toContain("Time to summarise");
    // The kept turn's image is text in the new epoch: no image block is sent any more.
    const lastCall = w.anthropic.calls[5]!.request;
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

describe("forget purges what the life cached (real fetcher)", () => {
  it("a DM picture she downloaded and read is indexed under the conversation and purged by a DM forget", async () => {
    const png = tinyPng(3, 3);
    const fetcher = new DiscordImageFetcher({
      dataRoot: "",
      logger: quietLogger() as never,
      fetch: (async () => new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } })) as typeof fetch
    });
    const w = await lifeWorld(roots, { options: {} });
    // The fetcher writes under this world's data root.
    (fetcher as unknown as { options: { dataRoot: string } }).options.dataRoot = w.root;
    (w.cast.deps as { images?: unknown }).images = fetcher;
    const message = w.discord.post(dmOf("aria"), "my cake!", { attachments: [{ ...image("9401"), size: png.length, url: `https://cdn.discordapp.com/attachments/1/9401/cake-9401.png` }] });
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    w.cast.intake.close();
    const ctx = await ctxFor(w);
    const read = await lifeTool("ReadMessages")!.run({ place: "dm/kevin" }, ctx);
    const saved = /\[image: (\/tmp\/dm\/kevin\/[0-9a-z]+-cake-9401\.png)\]/u.exec(textOf(read.content))![1]!;
    const look = await lifeTool("Read")!.run({ file_path: saved }, ctx);
    expect(kinds(look.content)).toContain("life_image");
    const conversation = path.join(w.root, "user/conversations", `dm_${KEVIN}_aria`);
    const indexed = JSON.parse(await readFile(path.join(conversation, "images.json"), "utf8")) as { keys: string[] };
    expect(indexed.keys).toEqual([expect.stringMatching(/^file:[0-9a-f]{64}$/u)]);
    const cacheDir = path.join(w.root, "app/cache/images");
    expect((await readdir(cacheDir, { recursive: true })).some((entry) => String(entry).length > 0)).toBe(true);
    const result = await dmForget(w.storage, { userId: KEVIN, waifuId: "aria", scope: "conversation" });
    expect(result.deleted.cachedImages).toBe(1);
    const left = (await readdir(cacheDir, { recursive: true }).catch(() => [])).filter((entry) => /\.(bin|png|img)$|^[0-9a-f]{16,}/u.test(String(path.basename(String(entry)))));
    expect(left).toEqual([]);
    await expect(readdir(conversation)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
