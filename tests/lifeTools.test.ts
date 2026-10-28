// Life tools (Living cast spec §6, §16): schemas and limits for every tool, D11 send permissions and
// attachments, her files (path rules, limits, the checked special files), ReadMessages downloads
// (her wakeups are in lifeWakeups.test.ts). Tools run directly against a temp
// data root and the fake Discord; no live calls.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import { homeStoreFor, refreshPlacesFile } from "../src/life/home/index.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { recordForgottenPerson } from "../src/orchestration/dm/forgotten.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { FakeImageFetcher } from "./contextFixtures.js";
import { CHANNEL, closeWorlds, dmOf, GUILD, herFile, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, tinyPdf, tinyPng, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function ctxFor(w: LifeWorld, waifuId = "ella"): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, waifuId);
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

const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, ctx);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
const hostPath = (w: LifeWorld, relative: string) => path.join(w.root, "user", "waifus", "ella", ...relative.split("/"));

/** Kevin DMs Ella (so the DM is a place she may write to, D11). */
async function kevinDms(w: LifeWorld, content = "hi ella", attachments?: RawDiscordMessage["attachments"]) {
  const message = w.discord.post(dmOf("ella"), content, attachments ? { attachments } : {});
  await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
  w.cast.intake.close();
  return message;
}

describe("SendMessage (§6.3, §16.3.2, D11)", () => {
  it("posts in a cast room (typing first), returns a ref, and refuses unknown places", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const sent = await run("SendMessage", { place: "bake-club/#general", text: "brownies are ready" }, ctx);
    expect(text(sent)).toMatch(/^sent #[0-9a-z]+$/u);
    expect(w.discord.typing).toEqual(["200000000000000002"]);
    expect(w.discord.sent).toMatchObject([{ placeKey: ROOM_KEY, content: "brownies are ready", senderBotId: "ella-bot" }]);
    expect(await run("SendMessage", { place: "elsewhere/#random", text: "hi" }, ctx)).toEqual({ content: "error: unknown place; see ~/life/places.md", isError: true });
    expect(await run("SendMessage", { place: "bake-club/#general", script: "" }, ctx)).toEqual({ content: "error: line 1: there is nothing to send: write each message on an m: line; nothing was sent", isError: true });
    expect((await run("SendMessage", { place: "bake-club/#general", text: "x".repeat(2001) }, ctx)).isError).toBe(true);
    // Missing access says why and that it can change, so she doesn't write the room off.
    w.discord.sendErrors.push(Object.assign(new Error("Missing Access"), { code: 50001 }));
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "hi" }, ctx))).toMatch(/can't post in this room right now; that can change/u);
  });

  it("never cold-DMs; a DM opens once the user wrote, until undeliverable, forgotten or rate-limited", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", dm: { allowDms: true, rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }] });
    let ctx = await ctxFor(w);
    expect((await run("SendMessage", { place: `dm_${KEVIN}_ella`, text: "hey kevin" }, ctx)).isError).toBe(true);
    await kevinDms(w);
    ctx = await ctxFor(w);
    expect(text(await run("SendMessage", { place: "dm/kevin", text: "hey kevin!" }, ctx))).toMatch(/^sent #/u);
    // The same turn may keep writing to him even though that reply reached the limit.
    expect(text(await run("SendMessage", { place: "dm/kevin", text: "and also" }, ctx))).toMatch(/^sent #/u);
    // A new turn is rate-limited.
    const next = await ctxFor(w);
    expect(await run("SendMessage", { place: "dm/kevin", text: "one more" }, next)).toEqual({ content: "error: you can't post there", isError: true });
    // Undeliverable (Discord 50007) closes the DM until he writes again.
    await updateDmLimit(w.storage, KEVIN, "ella", (limits) => ({ ...limits, replyTimestamps: [] }));
    w.discord.sendErrors.push(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    expect(await run("SendMessage", { place: "dm/kevin", text: "hello?" }, await ctxFor(w))).toEqual({ content: "error: they can't receive your messages right now", isError: true });
    expect((await run("SendMessage", { place: "dm/kevin", text: "hello??" }, await ctxFor(w))).isError).toBe(true);
  });

  it("a forget floor above his last message closes the DM", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    w.clock.advance(5_000);
    await updateDmLimit(w.storage, KEVIN, "ella", (limits) => ({ ...limits, floorMessageId: "999999999999999999999" }));
    expect(await run("SendMessage", { place: "dm/kevin", text: "hi" }, await ctxFor(w))).toEqual({ content: "error: you can't post there", isError: true });
  });

  it("caps distinct places per turn, refuses a paused server, strips a copied header and refuses tool-call syntax", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendPlacesPerTurn: 1 } }) });
    await kevinDms(w);
    const ctx = await ctxFor(w);
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "[14:02 #k3] Ella: hello all" }, ctx))).toMatch(/^sent/u);
    expect(w.discord.sent[0]!.content).toBe("hello all");
    expect(await run("SendMessage", { place: "dm/kevin", text: "hi" }, ctx)).toEqual({ content: "error: you've already written in 1 places this turn", isError: true });
    expect((await run("SendMessage", { place: "bake-club/#general", text: 'ReadMessages({"place":"bake-club/#general"})' }, ctx)).isError).toBe(true);
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, paused: true })
    });
    expect(await run("SendMessage", { place: "bake-club/#general", text: "still here?" }, await ctxFor(w))).toEqual({ content: "error: you can't post there", isError: true });
  });

  it("caps messages per turn at life.maxSendsPerTurn (M7)", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendsPerTurn: 2 } }) });
    const ctx = await ctxFor(w);
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "one" }, ctx))).toMatch(/^sent/u);
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "two" }, ctx))).toMatch(/^sent/u);
    expect(await run("SendMessage", { place: "bake-club/#general", text: "three" }, ctx)).toEqual({ content: "error: you've already sent 2 messages this turn; wait for replies", isError: true });
    expect(w.discord.sent.map((message) => message.content)).toEqual(["one", "two"]);
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "next turn" }, await ctxFor(w)))).toMatch(/^sent/u);
  });

  it("a waifu without her own bot cannot post (never through the House bot); the owner is told (M12)", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella" }] });
    const result = await run("SendMessage", { place: "bake-club/#general", text: "hello?" }, await ctxFor(w));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no Discord bot of your own/u);
    expect(w.discord.sent).toEqual([]);
    expect(w.discord.typing).toEqual([]);
    expect(w.cast.notices.list()).toEqual([expect.stringMatching(/has no Discord bot of her own/u)]);
  });

  it("attaches her files; private ones (MEMORY.md, the notes it links, her wakeups, places) are never attached, and a script naming one sends nothing", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await run("Write", { file_path: "~/MEMORY.md", content: "# Memory\n- [Kevin](people/kevin.md) — likes tea\n" }, ctx);
    await run("Write", { file_path: "~/people/kevin.md", content: "# Kevin\n- likes tea\n" }, ctx);
    await run("Write", { file_path: "~/flyer.txt", content: "BAKE SALE saturday\n" }, ctx);
    await run("Bash", { command: "cp ~/people/kevin.md ~/kevin-copy.md" }, ctx);
    await refreshPlacesFile(w.cast.deps, ctx.waifu);
    const refused = (file: string) => run("SendMessage", { place: "bake-club/#general", script: `m: the flyer\nattach ~/flyer.txt\nattach ${file}` }, ctx);
    const PRIVATE = "(your notes and the files in ~/life/ are private and can't be attached); nothing was sent";
    expect(await refused("/home/ella/MEMORY.md")).toEqual({ content: `error: line 3: can't attach ~/MEMORY.md ${PRIVATE}`, isError: true });
    expect(await refused("people/kevin.md")).toEqual({ content: `error: line 3: can't attach ~/people/kevin.md ${PRIVATE}`, isError: true });
    expect(await refused("~/life/places.md")).toEqual({ content: `error: line 3: can't attach ~/life/places.md ${PRIVATE}`, isError: true });
    expect(await refused("~/nope.txt")).toEqual({ content: "error: line 3: can't attach ~/nope.txt (it doesn't exist); nothing was sent", isError: true });
    expect(w.discord.sent).toEqual([]);
    // A copy under another name is hers to share.
    expect(text(await refused("~/kevin-copy.md"))).toMatch(/^sent #[0-9a-z]+$/u);
    expect(w.discord.sent[0]!.files).toEqual([
      { name: "flyer.txt", size: 19 },
      { name: "kevin-copy.md", size: 20 }
    ]);
    // Files only (an attach line on its own) is a message; so is an old call with files and no text.
    expect(text(await run("SendMessage", { place: "bake-club/#general", script: "attach ~/flyer.txt" }, await ctxFor(w)))).toMatch(/^sent #/u);
    expect(w.discord.sent[1]).toMatchObject({ content: "", files: [{ name: "flyer.txt" }] });
    expect(text(await run("SendMessage", { place: "bake-club/#general", files: ["~/flyer.txt"] }, await ctxFor(w)))).toMatch(/^sent #/u);
    expect(w.discord.sent).toHaveLength(3);
  });

  it("caps attachments at life.send.maxFiles; a file over 10 MB or a folder is refused", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, send: { ...config.life.send, maxFiles: 1 } } }) });
    const ctx = await ctxFor(w);
    await mkdir(hostPath(w, "tmp/big"), { recursive: true });
    await writeFile(hostPath(w, "tmp/big/huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await writeFile(hostPath(w, "tmp/a.txt"), "a");
    await writeFile(hostPath(w, "tmp/b.txt"), "b");
    const send = (script: string) => run("SendMessage", { place: "bake-club/#general", script }, ctx);
    expect(text(await send("m: files\nattach /tmp/big/huge.bin"))).toBe("error: line 2: can't attach /tmp/big/huge.bin (larger than 10 MB); nothing was sent");
    expect(text(await send("m: files\nattach /tmp/a.txt\nattach /tmp/b.txt"))).toBe("error: line 3: at most 1 file per message; nothing was sent");
    expect(text(await send("m: files\nattach /tmp/big"))).toBe("error: line 2: can't attach /tmp/big (it is a folder); nothing was sent");
    expect(text(await send("m: files\nattach /tmp/a.txt\nm: and\nattach /tmp/b.txt"))).toMatch(/^sent #\w+ #\w+$/u);
    expect(w.discord.sent.map((entry) => entry.files)).toEqual([[{ name: "a.txt", size: 1 }], [{ name: "b.txt", size: 1 }]]);
  });
});

describe("ReadMessages (§6.2) and React (§6.4)", () => {
  it("renders the transcript with refs, pages with before, and shows forgotten authors as removed", async () => {
    const w = await lifeWorld(roots);
    for (let index = 1; index <= 20; index += 1) w.discord.post(ROOM, `message ${index}`, index % 2 ? {} : { authorId: MINA_USER, authorName: "Mina" });
    const ctx = await ctxFor(w);
    const first = text(await run("ReadMessages", { place: "bake-club/#general", query: "max:5" }, ctx));
    const lines = first.split("\n");
    expect(lines[0]).toBe("bake-club/#general (Bake Club › #general)");
    expect(lines[1]).toMatch(/^— more before: before #[0-9a-z]+ —$/u);
    expect(lines.slice(2, 7).map((line) => line.replace(/^\[\d\d:\d\d #[0-9a-z]+\] /u, ""))).toEqual(["Mina: message 16", "Kevin: message 17", "Mina: message 18", "Kevin: message 19", "Mina: message 20"]);
    const before = /before (#[0-9a-z]+) —/u.exec(lines[1]!)![1]!;
    // The ref is included: message 16 and the two before it.
    const older = text(await run("ReadMessages", { place: "bake-club/#general", query: `before ${before} max:2` }, ctx));
    expect(older).toContain("message 14");
    expect(older).toContain("message 15");
    expect(older).toContain("message 16");
    expect(older).not.toContain("message 13");
    expect(await run("ReadMessages", { place: "bake-club/#general", query: "before #zzzz" }, ctx)).toEqual({ content: "error: message too old", isError: true });
    for (const max of [0, 101]) expect((await run("ReadMessages", { place: "bake-club/#general", query: `max:${max}` }, ctx)).isError).toBe(true);
    // The owner forgot Mina: her messages so far read as (removed).
    await recordForgottenPerson(w.storage, MINA_USER, w.clock.now());
    const after = text(await run("ReadMessages", { place: "bake-club/#general", query: "max:2" }, ctx));
    expect(after).toMatch(/someone: \(removed\)/u);
    expect(after).not.toContain("message 20");
    const state = await readLifeFile(w.storage, "ella", "reads");
    expect(state.cursors[ROOM_KEY]?.lastReadMessageId).toBeTruthy();
  });

  it("reacts with unicode or a server emoji through her own bot", async () => {
    const w = await lifeWorld(roots);
    w.discord.post(ROOM, "we won the bake-off!");
    const ctx = await ctxFor(w);
    const read = text(await run("ReadMessages", { place: "bake-club/#general", query: "max:1" }, ctx));
    const ref = /#([0-9a-z]+)\]/u.exec(read)![1]!;
    expect(text(await run("React", { place: "bake-club/#general", ref: `#${ref}`, emoji: "🎉" }, ctx))).toBe("reacted");
    expect(w.discord.reactions).toMatchObject([{ placeKey: ROOM_KEY, emoji: "🎉", botId: "ella-bot" }]);
    expect(await run("React", { place: "bake-club/#general", ref: `#${ref}`, emoji: ":partyblob:" }, ctx)).toEqual({ content: "error: there is no :partyblob: emoji here", isError: true });
    expect(await run("React", { place: "bake-club/#general", ref: "#nope", emoji: "🎉" }, ctx)).toEqual({ content: "error: message too old", isError: true });
  });
});

const attachment = (id: string, filename: string, contentType: string, size: number): RawDiscordMessage["attachments"][number] => ({
  id,
  url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${id}/${filename}`,
  filename,
  contentType,
  size
});

describe("ReadMessages downloads (§16.3.1)", () => {
  it("saves images, PDFs and text files into /tmp/<place>/; lists the rest as not downloaded; no inline images; dedupes by attachment id", async () => {
    const fetcher = new FakeImageFetcher();
    const png = tinyPng();
    const pdf = tinyPdf(["Menu: lemon tart"]);
    fetcher.files.set("att:5001", png);
    fetcher.files.set("att:5002", pdf);
    fetcher.files.set("att:5003", Buffer.from("flour,sugar\n"));
    const w = await lifeWorld(roots, { options: { images: fetcher, ocr: { cachedText: async (ref) => (ref.key === "att:5001" ? "SALE 50%" : undefined) } } });
    w.discord.post(ROOM, "look", {
      attachments: [
        attachment("5001", "cake.png", "image/png", png.length),
        attachment("5002", "menu.pdf", "application/pdf", pdf.length),
        attachment("5003", "list.csv", "text/csv", 12),
        attachment("5004", "song.mp3", "audio/mpeg", 3_000_000),
        attachment("5005", "huge.png", "image/png", 11 * 1024 * 1024)
      ]
    });
    const ctx = await ctxFor(w);
    const result = await run("ReadMessages", { place: "bake-club/#general" }, ctx);
    expect(typeof result.content).toBe("string");
    const body = text(result);
    const ref = /#([0-9a-z]+)\] Kevin: look/u.exec(body)![1]!;
    expect(body).toContain(`[image: /tmp/bake-club/general/${ref}-cake.png · "SALE 50%"]`);
    expect(body).toMatch(new RegExp(`\\[file: /tmp/bake-club/general/${ref}-menu\\.pdf · [0-9.]+ [kK]?B\\]`, "u"));
    expect(body).toContain(`[file: /tmp/bake-club/general/${ref}-list.csv · 12 B]`);
    expect(body).toMatch(/\[file: song\.mp3 · 2\.9 MB · not downloaded\]/u);
    expect(body).toMatch(/\[image: huge\.png · 11(\.0)? MB · not downloaded\]/u);
    expect(await readFile(hostPath(w, `tmp/bake-club/general/${ref}-cake.png`))).toEqual(png);
    expect(await herFile(w, "ella", `tmp/bake-club/general/${ref}-list.csv`)).toBe("flour,sugar\n");
    // The provenance index knows each download (not visible to her).
    const index = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/files-index.json"), "utf8")) as { entries: Array<{ attachmentId: string; authorId: string; placeKey: string }> };
    expect(index.entries.map((entry) => entry.attachmentId).sort()).toEqual(["5001", "5002", "5003"]);
    expect(index.entries.every((entry) => entry.authorId === KEVIN && entry.placeKey === ROOM_KEY)).toBe(true);
    // Read again: nothing is fetched again while the files are there.
    expect(fetcher.fileCalls).toHaveLength(3);
    await run("ReadMessages", { place: "bake-club/#general" }, ctx);
    expect(fetcher.fileCalls).toHaveLength(3);
    // An expired (deleted) download is fetched again when read again.
    await rm(hostPath(w, `tmp/bake-club/general/${ref}-cake.png`));
    await run("ReadMessages", { place: "bake-club/#general" }, ctx);
    expect(fetcher.fileCalls).toHaveLength(4);
  });

  it("downloads at most 10 per call, never a removed message's attachments, and puts DM downloads under /tmp/dm/<handle>/", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, { options: { images: fetcher } });
    w.discord.post(ROOM, "many", { attachments: Array.from({ length: 12 }, (_, index) => attachment(String(6000 + index), `n${index}.txt`, "text/plain", 5)) });
    w.discord.post(ROOM, "mina's", { authorId: MINA_USER, authorName: "Mina", attachments: [attachment("6100", "secret.txt", "text/plain", 5)] });
    await recordForgottenPerson(w.storage, MINA_USER, w.clock.now());
    const body = text(await run("ReadMessages", { place: "bake-club/#general" }, await ctxFor(w)));
    expect(body.match(/not downloaded \(too many in one read; read fewer\)\]/gu)).toHaveLength(2);
    expect(fetcher.fileCalls.map((ref) => ref.attachmentId)).not.toContain("6100");
    expect(fetcher.fileCalls).toHaveLength(10);
    await kevinDms(w, "my recipe", [attachment("6200", "recipe.md", "text/markdown", 5)]);
    const dm = text(await run("ReadMessages", { place: "dm/kevin" }, await ctxFor(w)));
    expect(dm).toMatch(/\[file: \/tmp\/dm\/kevin\/[0-9a-z]+-recipe\.md · 5 B\]/u);
  });
});

describe("Read, Write, Edit and the path rules (§16.2, §16.3.3, §16.3.4)", { timeout: 60_000 }, () => {
  it("enforces the path rules on every path form", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    for (const good of ["MEMORY.md", "~/me.md", "/home/ella/people/kevin.md", "places/bake-club/recipes.md", "/tmp/scratch.txt", "people/../notes.txt", "~/a/b/c/d/e/f/g.md"]) {
      expect((await run("Write", { file_path: good, content: "# x\n" }, ctx)).isError, good).toBeFalsy();
    }
    for (const bad of ["/etc/passwd", "../me.md", "~/../mina/x.md", "/home/mina/x.md", "/tmp/../home/ella/x.md/..", "a\\b.md", "con.txt", "people/NUL", "~/a/b/c/d/e/f/g/h/i.md", `${"x".repeat(101)}.md`, "", "~", "/tmp"]) {
      expect((await run("Write", { file_path: bad, content: "x" }, ctx)).isError, bad).toBe(true);
    }
    // Device names in every disguise, and names ending in a dot or a space, are refused.
    for (const bad of ["people/con ", "aux.", "~/COM\u00b9.txt", "lpt1 .md", "notes.", "people /x.md", "people./x.md"]) {
      expect((await run("Write", { file_path: bad, content: "x" }, ctx)).isError, bad).toBe(true);
    }
    // A name that differs only by case is the file or folder already there (case-insensitive disks).
    expect(text(await run("Write", { file_path: "~/People/x.md", content: "x" }, ctx))).toBe("wrote ~/people/x.md (1 B)");
    expect(text(await run("Write", { file_path: "~/me.MD", content: "x" }, ctx))).toBe("wrote ~/me.md (1 B)");
    expect(await herFile(w, "ella", "home/me.md")).toBe("x");
    // No host path leaks into any error.
    const outside = await run("Read", { file_path: "/etc/passwd" }, ctx);
    expect(text(outside)).toBe("error: /etc/passwd is outside your folders (your home ~ and /tmp)");
    expect(text(outside)).not.toContain(w.root);
  });

  it("never follows a link the owner made", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await run("Write", { file_path: "~/real.md", content: "real\n" }, ctx);
    await symlink(hostPath(w, "home/real.md"), hostPath(w, "home/link.md"));
    await symlink(w.root, hostPath(w, "home/rootlink"));
    expect(text(await run("Read", { file_path: "~/link.md" }, ctx))).toBe("error: ~/link.md can't be used: it is a link");
    expect(text(await run("Write", { file_path: "~/link.md", content: "x" }, ctx))).toBe("error: ~/link.md can't be used: it is a link");
    expect((await run("Read", { file_path: "~/rootlink/user/waifus/ella/home/real.md" }, ctx)).isError).toBe(true);
    expect(await readFile(hostPath(w, "home/real.md"), "utf8")).toBe("real\n");
  });

  it("Read numbers lines like cat -n, with offset and limit; Write and Edit report what they did; places.md is read-only", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(text(await run("Write", { file_path: "~/people/kevin.md", content: "# Kevin\n- likes tea\n- likes tea a lot\n" }, ctx))).toBe("wrote ~/people/kevin.md (38 B)");
    expect(text(await run("Read", { file_path: "people/kevin.md" }, ctx))).toBe("     1\t# Kevin\n     2\t- likes tea\n     3\t- likes tea a lot");
    expect(text(await run("Read", { file_path: "people/kevin.md", offset: 2, limit: 1 }, ctx))).toBe("     2\t- likes tea\n(lines 2–2 of 3; pass offset 3 to read on)");
    expect(await run("Edit", { file_path: "~/people/kevin.md", old_string: "likes tea", new_string: "likes coffee" }, ctx)).toEqual({
      content: "error: old_string appears 2 times in ~/people/kevin.md; include more of the surrounding text, or pass replace_all",
      isError: true
    });
    expect(await run("Edit", { file_path: "~/people/kevin.md", old_string: "hates tea", new_string: "x" }, ctx)).toEqual({ content: "error: old_string is not in ~/people/kevin.md; read it first", isError: true });
    expect(text(await run("Edit", { file_path: "~/people/kevin.md", old_string: "likes tea a lot", new_string: "likes coffee now" }, ctx))).toBe("edited ~/people/kevin.md");
    expect(text(await run("Edit", { file_path: "~/people/kevin.md", old_string: "likes", new_string: "loves", replace_all: true }, ctx))).toMatch(/^edited ~\/people\/kevin\.md/u);
    expect(await herFile(w, "ella", "home/people/kevin.md")).toBe("# Kevin\n- loves tea\n- loves coffee now\n");
    expect(text(await run("Write", { file_path: "~/empty.md", content: "" }, ctx))).toBe("wrote ~/empty.md (0 B)");
    expect(text(await run("Read", { file_path: "~/empty.md" }, ctx))).toBe("(empty file)");
    expect(text(await run("Read", { file_path: "~/missing.md" }, ctx))).toBe("error: ~/missing.md doesn't exist");
    await refreshPlacesFile(w.cast.deps, ctx.waifu);
    expect(text(await run("Read", { file_path: "~/life/places.md" }, ctx))).toContain("bake-club/#general");
    for (const [tool, input] of [
      ["Write", { file_path: "~/life/places.md", content: "x" }],
      ["Edit", { file_path: "~/life/places.md", old_string: "Rooms", new_string: "x" }]
    ] as const) {
      expect(await run(tool, input, ctx)).toEqual({ content: "error: places.md is kept up to date for you and can't be changed", isError: true });
    }
    expect(text(await run("Bash", { command: "rm ~/life/places.md" }, ctx))).toMatch(/places\.md/u);
    expect(await herFile(w, "ella", "home/life/places.md")).toContain("# Your places");
  });

  it("limits a written file to 256 KiB and her home to its file count; binary files are not text", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, home: { ...config.life.home, maxFiles: 10 } } }) });
    const ctx = await ctxFor(w);
    expect(await run("Write", { file_path: "big.md", content: "x".repeat(256 * 1024 + 1) }, ctx)).toEqual({ content: "error: a file can be at most 256 KB; split it into several files", isError: true });
    for (let index = 0; index < 10; index += 1) expect((await run("Write", { file_path: `n/n${index}.md`, content: "x" }, ctx)).isError).toBeFalsy();
    expect(await run("Write", { file_path: "one-too-many.md", content: "x" }, ctx)).toEqual({ content: "error: your home has 10 files already; merge or delete some first", isError: true });
    // /tmp has its own size cap, not the home's file count.
    expect((await run("Write", { file_path: "/tmp/scratch.md", content: "x" }, ctx)).isError).toBeFalsy();
    await writeFile(hostPath(w, "tmp/blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    expect(text(await run("Read", { file_path: "/tmp/blob.bin" }, ctx))).toBe("error: /tmp/blob.bin isn't a text file, an image or a PDF");
    expect(text(await run("Edit", { file_path: "/tmp/blob.bin", old_string: "a", new_string: "b" }, ctx))).toBe("error: /tmp/blob.bin isn't a text file");
  });

  it("Read shows a PDF's text with page markers, a page range, and refuses more than 50 pages at once", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await mkdir(hostPath(w, "tmp"), { recursive: true });
    await writeFile(hostPath(w, "tmp/menu.pdf"), tinyPdf(["Lemon tart 4 EUR", "Brownies 3 EUR", "Opening hours 9-5"]));
    const all = text(await run("Read", { file_path: "/tmp/menu.pdf" }, ctx));
    expect(all).toMatch(/^\/tmp\/menu\.pdf: PDF, 3 pages\n--- page 1 ---\nLemon tart 4 EUR\n--- page 2 ---\nBrownies 3 EUR\n--- page 3 ---\nOpening hours 9-5/u);
    const two = text(await run("Read", { file_path: "/tmp/menu.pdf", pages: "2" }, ctx));
    expect(two).toContain("--- page 2 ---");
    expect(two).not.toContain("--- page 1 ---");
    expect(await run("Read", { file_path: "/tmp/menu.pdf", pages: "1-51" }, ctx)).toEqual({ content: "error: read at most 50 pages at a time", isError: true });
    expect(text(await run("Read", { file_path: "/tmp/menu.pdf", pages: "9" }, ctx))).toBe("error: /tmp/menu.pdf has 3 pages; nothing at page 9");
  });
});

describe("tool list (§16.3)", () => {
  it("offers the nine tools; Web while search or page fetching is on (§31); Bash only while enabled", async () => {
    const w = await lifeWorld(roots);
    expect(offeredToolNames(w.cast.deps)).toEqual(["ReadMessages", "SendMessage", "React", "Wakeup", "Read", "Write", "Edit", "Bash", "Web"]);
    // One of the two on is enough: the other function throws in her script.
    w.setConfig((config) => ({ ...config, search: { ...config.search, maxPerDay: 0 } }));
    expect(offeredToolNames(w.cast.deps)).toContain("Web");
    w.setConfig((config) => ({ ...config, life: { ...config.life, webFetch: { ...config.life.webFetch, maxPerTurn: 0 }, bash: { ...config.life.bash, enabled: false } } }));
    expect(offeredToolNames(w.cast.deps)).toEqual(["ReadMessages", "SendMessage", "React", "Wakeup", "Read", "Write", "Edit"]);
    for (const retired of ["list_places", "write_note", "list_watches", "cancel_wake", "send_message", "WatchFor", "ScheduleWake", "WebSearch", "WebFetch"]) expect(lifeTool(retired)).toBeUndefined();
  });

  it("~/life/places.md lists her rooms and private chats by handle", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    const ctx = await ctxFor(w);
    expect(await refreshPlacesFile(w.cast.deps, ctx.waifu)).toBe(true);
    // Unchanged: not rewritten.
    expect(await refreshPlacesFile(w.cast.deps, ctx.waifu)).toBe(false);
    const listed = (await herFile(w, "ella", "home/life/places.md"))!;
    expect(listed).toMatch(/^# Your places\n\(This file is kept up to date for you/u);
    expect(listed).toContain("- bake-club/#general (Bake Club › #general)");
    expect(listed).toContain("- bake-club/#recipes");
    expect(listed).toContain("- dm/kevin (Kevin)");
  });
});
