// Life tools (Living cast spec §6, §16): schemas and limits for every tool, D11 send permissions and
// attachments, her files (path rules, limits, the checked reminder and watch files), watch matching
// and `from` resolution, schedule limits, ReadMessages downloads. Tools run directly against a temp
// data root and the fake Discord; no live calls.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import { fireWatches, bindingMatch } from "../src/life/watches.js";
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

async function ctxFor(w: LifeWorld, waifuId = "aria"): Promise<ToolContext> {
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
const hostPath = (w: LifeWorld, relative: string) => path.join(w.root, "user", "waifus", "aria", ...relative.split("/"));

/** Kevin DMs Aria (so the DM is a place she may write to, D11). */
async function kevinDms(w: LifeWorld, content = "hi aria", attachments?: RawDiscordMessage["attachments"]) {
  const message = w.discord.post(dmOf("aria"), content, attachments ? { attachments } : {});
  await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
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
    expect(w.discord.sent).toMatchObject([{ placeKey: ROOM_KEY, content: "brownies are ready", senderBotId: "aria-bot" }]);
    expect(await run("SendMessage", { place: "elsewhere/#random", text: "hi" }, ctx)).toEqual({ content: "error: unknown place; see ~/places.md", isError: true });
    expect(await run("SendMessage", { place: "bake-club/#general", text: "" }, ctx)).toEqual({ content: "error: there is nothing to send", isError: true });
    expect((await run("SendMessage", { place: "bake-club/#general", text: "x".repeat(2001) }, ctx)).isError).toBe(true);
  });

  it("never cold-DMs; a DM opens once the user wrote, until undeliverable, forgotten or rate-limited", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", dm: { allowDms: true, rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }] });
    let ctx = await ctxFor(w);
    expect((await run("SendMessage", { place: `dm_${KEVIN}_aria`, text: "hey kevin" }, ctx)).isError).toBe(true);
    await kevinDms(w);
    ctx = await ctxFor(w);
    expect(text(await run("SendMessage", { place: "dm/kevin", text: "hey kevin!" }, ctx))).toMatch(/^sent #/u);
    // The same turn may keep writing to him even though that reply reached the limit.
    expect(text(await run("SendMessage", { place: "dm/kevin", text: "and also" }, ctx))).toMatch(/^sent #/u);
    // A new turn is rate-limited.
    const next = await ctxFor(w);
    expect(await run("SendMessage", { place: "dm/kevin", text: "one more" }, next)).toEqual({ content: "error: you can't post there", isError: true });
    // Undeliverable (Discord 50007) closes the DM until he writes again.
    await updateDmLimit(w.storage, KEVIN, "aria", (limits) => ({ ...limits, replyTimestamps: [] }));
    w.discord.sendErrors.push(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    expect(await run("SendMessage", { place: "dm/kevin", text: "hello?" }, await ctxFor(w))).toEqual({ content: "error: they can't receive your messages right now", isError: true });
    expect((await run("SendMessage", { place: "dm/kevin", text: "hello??" }, await ctxFor(w))).isError).toBe(true);
  });

  it("a forget floor above his last message closes the DM", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    w.clock.advance(5_000);
    await updateDmLimit(w.storage, KEVIN, "aria", (limits) => ({ ...limits, floorMessageId: "999999999999999999999" }));
    expect(await run("SendMessage", { place: "dm/kevin", text: "hi" }, await ctxFor(w))).toEqual({ content: "error: you can't post there", isError: true });
  });

  it("caps distinct places per turn, refuses a paused server, strips a copied header and refuses tool-call syntax", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendPlacesPerTurn: 1 } }) });
    await kevinDms(w);
    const ctx = await ctxFor(w);
    expect(text(await run("SendMessage", { place: "bake-club/#general", text: "[14:02 #k3] Aria: hello all" }, ctx))).toMatch(/^sent/u);
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
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria" }] });
    const result = await run("SendMessage", { place: "bake-club/#general", text: "hello?" }, await ctxFor(w));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no Discord bot of your own/u);
    expect(w.discord.sent).toEqual([]);
    expect(w.discord.typing).toEqual([]);
    expect(w.cast.notices.list()).toEqual([expect.stringMatching(/has no Discord bot of her own/u)]);
  });

  it("attaches her files; private ones (MEMORY.md, the notes it links, reminders, watches, places) are never attached and the message still goes", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await run("Write", { file_path: "~/MEMORY.md", content: "# Memory\n- [Kevin](people/kevin.md) — likes tea\n" }, ctx);
    await run("Write", { file_path: "~/people/kevin.md", content: "# Kevin\n- likes tea\n" }, ctx);
    await run("Write", { file_path: "~/flyer.txt", content: "BAKE SALE saturday\n" }, ctx);
    await run("Bash", { command: "cp ~/people/kevin.md ~/kevin-copy.md" }, ctx);
    await refreshPlacesFile(w.cast.deps, ctx.waifu);
    const sent = await run(
      "SendMessage",
      { place: "bake-club/#general", text: "the flyer", files: ["~/flyer.txt", "/home/aria/MEMORY.md", "people/kevin.md", "~/places.md", "~/kevin-copy.md", "~/nope.txt"] },
      ctx
    );
    expect(sent.isError).toBeFalsy();
    expect(text(sent)).toMatch(/^sent #[0-9a-z]+; not attached: /u);
    expect(text(sent)).toContain("~/MEMORY.md (your notes, reminders, watches and places are private and can't be attached)");
    expect(text(sent)).toContain("~/people/kevin.md (your notes, reminders, watches and places are private and can't be attached)");
    expect(text(sent)).toContain("~/places.md (your notes, reminders, watches and places are private and can't be attached)");
    expect(text(sent)).toContain("~/nope.txt (it doesn't exist)");
    // A copy under another name is hers to share.
    expect(w.discord.sent[0]!.files).toEqual([
      { name: "flyer.txt", size: 19 },
      { name: "kevin-copy.md", size: 20 }
    ]);
    // Files only (no text) is a message; only private files is nothing, and nothing is sent.
    expect(text(await run("SendMessage", { place: "bake-club/#general", files: ["~/flyer.txt"] }, await ctxFor(w)))).toMatch(/^sent #/u);
    expect(w.discord.sent[1]).toMatchObject({ content: "", files: [{ name: "flyer.txt" }] });
    const nothing = await run("SendMessage", { place: "bake-club/#general", files: ["~/MEMORY.md"] }, await ctxFor(w));
    expect(nothing).toEqual({ content: "error: nothing was sent: not attached: ~/MEMORY.md (your notes, reminders, watches and places are private and can't be attached)", isError: true });
    expect(w.discord.sent).toHaveLength(2);
  });

  it("caps attachments at life.send.maxFiles; a file over 10 MB or a folder is skipped", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, send: { ...config.life.send, maxFiles: 1 } } }) });
    const ctx = await ctxFor(w);
    await mkdir(hostPath(w, "tmp/big"), { recursive: true });
    await writeFile(hostPath(w, "tmp/big/huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await writeFile(hostPath(w, "tmp/a.txt"), "a");
    await writeFile(hostPath(w, "tmp/b.txt"), "b");
    const sent = text(await run("SendMessage", { place: "bake-club/#general", text: "files", files: ["/tmp/big/huge.bin", "/tmp/a.txt", "/tmp/b.txt", "/tmp/big"] }, ctx));
    expect(sent).toContain("/tmp/big/huge.bin (larger than 10 MB)");
    expect(sent).toContain("/tmp/b.txt (at most 1 file per message)");
    expect(w.discord.sent[0]!.files).toEqual([{ name: "a.txt", size: 1 }]);
  });
});

describe("ReadMessages (§6.2) and React (§6.4)", () => {
  it("renders the transcript with refs, pages with before, and shows forgotten authors as removed", async () => {
    const w = await lifeWorld(roots);
    for (let index = 1; index <= 20; index += 1) w.discord.post(ROOM, `message ${index}`, index % 2 ? {} : { authorId: MINA_USER, authorName: "Mina" });
    const ctx = await ctxFor(w);
    const first = text(await run("ReadMessages", { place: "bake-club/#general", limit: 5 }, ctx));
    const lines = first.split("\n");
    expect(lines[0]).toBe("bake-club/#general (Bake Club › #general)");
    expect(lines.slice(1, 6).map((line) => line.replace(/^\[\d\d:\d\d #[0-9a-z]+\] /u, ""))).toEqual(["Mina: message 16", "Kevin: message 17", "Mina: message 18", "Kevin: message 19", "Mina: message 20"]);
    const footer = lines[lines.length - 1]!;
    expect(footer).toMatch(/^— older messages available; pass before:"#[0-9a-z]+" —$/u);
    const before = /before:"(#[0-9a-z]+)"/u.exec(footer)![1]!;
    const older = text(await run("ReadMessages", { place: "bake-club/#general", limit: 2, before }, ctx));
    expect(older).toContain("message 14");
    expect(older).toContain("message 15");
    expect(await run("ReadMessages", { place: "bake-club/#general", before: "#zzzz" }, ctx)).toEqual({ content: "error: message too old", isError: true });
    for (const limit of [0, 51]) expect((await run("ReadMessages", { place: "bake-club/#general", limit }, ctx)).isError).toBe(true);
    // The owner forgot Mina: her messages so far read as (removed).
    await recordForgottenPerson(w.storage, MINA_USER, w.clock.now());
    const after = text(await run("ReadMessages", { place: "bake-club/#general", limit: 2 }, ctx));
    expect(after).toMatch(/someone: \(removed\)/u);
    expect(after).not.toContain("message 20");
    const state = await readLifeFile(w.storage, "aria", "reads");
    expect(state.cursors[ROOM_KEY]?.lastReadMessageId).toBeTruthy();
  });

  it("reacts with unicode or a server emoji through her own bot", async () => {
    const w = await lifeWorld(roots);
    w.discord.post(ROOM, "we won the bake-off!");
    const ctx = await ctxFor(w);
    const read = text(await run("ReadMessages", { place: "bake-club/#general", limit: 1 }, ctx));
    const ref = /#([0-9a-z]+)\]/u.exec(read)![1]!;
    expect(text(await run("React", { place: "bake-club/#general", ref: `#${ref}`, emoji: "🎉" }, ctx))).toBe("reacted");
    expect(w.discord.reactions).toMatchObject([{ placeKey: ROOM_KEY, emoji: "🎉", botId: "aria-bot" }]);
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
    expect(await herFile(w, "aria", `tmp/bake-club/general/${ref}-list.csv`)).toBe("flour,sugar\n");
    // The provenance index knows each download (not visible to her).
    const index = JSON.parse(await readFile(path.join(w.root, "user/waifus/aria/life/files-index.json"), "utf8")) as { entries: Array<{ attachmentId: string; authorId: string; placeKey: string }> };
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
    expect(body.match(/not downloaded\]/gu)).toHaveLength(2);
    expect(fetcher.fileCalls.map((ref) => ref.attachmentId)).not.toContain("6100");
    expect(fetcher.fileCalls).toHaveLength(10);
    await kevinDms(w, "my recipe", [attachment("6200", "recipe.md", "text/markdown", 5)]);
    const dm = text(await run("ReadMessages", { place: "dm/kevin" }, await ctxFor(w)));
    expect(dm).toMatch(/\[file: \/tmp\/dm\/kevin\/[0-9a-z]+-recipe\.md · 5 B\]/u);
  });
});

describe("WatchFor and ~/watches.json (§16.5)", () => {
  it("validates bindings and timeout, resolves `from` (ambiguity is an error), caps watches at 10, and saves them in her file", async () => {
    const w = await lifeWorld(roots);
    // Two people she knows as Kevin (from her DMs).
    for (const userId of [KEVIN, MINA_USER]) {
      const message = w.discord.post(dmOf("aria", userId), "hi", { authorId: userId, authorName: "Kevin" });
      await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    }
    w.cast.intake.close();
    const ctx = await ctxFor(w);
    const watch = (input: Record<string, unknown>) => run("WatchFor", { note: "n", timeout_minutes: 60, ...input }, ctx);
    expect((await watch({ when: [{}] })).content).toBe("error: when.0: each binding needs a place, from, words or any_message");
    expect((await watch({ when: [{ any_message: true }], timeout_minutes: 0 })).isError).toBe(true);
    expect((await watch({ when: [{ any_message: true }], timeout_minutes: 10_081 })).isError).toBe(true);
    expect((await watch({ when: [{ words: Array.from({ length: 11 }, (_, i) => `w${i}`) }] })).isError).toBe(true);
    expect(text(await watch({ when: [{ from: "Kevin" }] }))).toMatch(/^error: watches\.json entry 1: more than one person called Kevin; use <@id>$/u);
    expect(text(await watch({ when: [{ place: "nowhere/#x" }] }))).toMatch(/^error: watches\.json entry 1: unknown place nowhere\/#x; see places\.md$/u);
    expect(text(await watch({ when: [{ from: `<@${KEVIN}>`, words: ["cake"] }], note: "Kevin's cake news" }))).toMatch(/^watching w1 until Sat 24 Oct 15:0\d \(in ~\/watches\.json\)$/u);
    // A timer: no bindings, only a timeout.
    expect(text(await watch({ when: [], note: "tea's ready", timeout_minutes: 5 }))).toMatch(/^watching w2 until /u);
    const file = JSON.parse((await herFile(w, "aria", "home/watches.json"))!) as Array<Record<string, unknown>>;
    expect(file[0]).toEqual({ id: "w1", timeout: expect.stringMatching(/^2026-10-24 15:0\d$/u), once: true, note: "Kevin's cake news", when: [{ from: `<@${KEVIN}>`, words: ["cake"] }] });
    expect(file[1]).toMatchObject({ id: "w2", note: "tea's ready", when: [] });
    // The resolution lives outside her folder.
    const ids = JSON.parse(await readFile(path.join(w.root, "user/waifus/aria/life/watch-ids.json"), "utf8")) as { watches: Record<string, { bindings: unknown[] }> };
    expect(ids.watches["w1"]!.bindings).toEqual([{ fromUserId: KEVIN, fromName: "Kevin", words: ["cake"] }]);
    for (let index = 3; index <= 10; index += 1) expect((await watch({ when: [{ any_message: true }] })).isError).toBeFalsy();
    expect(await watch({ when: [{ any_message: true }] })).toEqual({ content: "error: you already have 10 watches; remove one from ~/watches.json first", isError: true });
  });

  it("matches place, person, whole words or any message; once-watches go at the first match; spacing and daily cap", async () => {
    expect(bindingMatch({ words: ["brownie"] }, { placeKey: ROOM_KEY, authorId: KEVIN, text: "Brownies?", own: false })).toBeUndefined();
    expect(bindingMatch({ words: ["brownie"] }, { placeKey: ROOM_KEY, authorId: KEVIN, text: "one BROWNIE please", own: false })).toBe("brownie");
    expect(bindingMatch({ fromUserId: KEVIN, fromName: "Kevin" }, { placeKey: "elsewhere", authorId: KEVIN, text: "x", own: false })).toBe("from Kevin");
    expect(bindingMatch({ placeKey: ROOM_KEY, fromUserId: KEVIN }, { placeKey: ROOM_KEY, authorId: MINA_USER, text: "x", own: false })).toBeUndefined();
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const written = await run(
      "Write",
      {
        file_path: "~/watches.json",
        content: JSON.stringify([
          { timeout: "2026-10-25 14:00", once: true, note: "once", when: [{ place: "bake-club/#general", any_message: true }] },
          { timeout: "2026-10-25 14:00", once: false, note: "repeat", when: [{ words: ["cake"] }] }
        ])
      },
      ctx
    );
    expect(text(written)).toMatch(/^wrote ~\/watches\.json \(.*; new entries got ids\)$/u);
    const store = homeStoreFor(w.cast.deps, ctx.waifu);
    const now = w.clock.now();
    const message = (body: string, own = false) => ({ placeKey: ROOM_KEY, authorId: KEVIN, text: body, own });
    const fire = (body: string, at: Date, own = false) => fireWatches(store, message(body, own), { now: at, timeZone: "UTC", maxFiresPerDay: 2 });
    expect(await fire("cake time", now, true)).toEqual([]);
    expect((await fire("cake time", now)).map((hit) => hit.watch.id)).toEqual(["w1", "w2"]);
    expect(await fire("more cake", new Date(now.getTime() + 5 * 60_000))).toEqual([]);
    expect((await fire("more cake", new Date(now.getTime() + 11 * 60_000))).map((hit) => hit.watch.id)).toEqual(["w2"]);
    expect(await fire("cake again", new Date(now.getTime() + 30 * 60_000))).toEqual([]);
    const left = JSON.parse((await herFile(w, "aria", "home/watches.json"))!) as Array<{ id: string }>;
    expect(left.map((entry) => entry.id)).toEqual(["w2"]);
  });

  it("a hand-broken file is refused with its line and column and stays unchanged; an edit that drops an entry is fine", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await run("WatchFor", { when: [{ words: ["cake"] }], note: "cake", timeout_minutes: 60 }, ctx);
    await run("WatchFor", { when: [], note: "tea", timeout_minutes: 30 }, ctx);
    const before = (await herFile(w, "aria", "home/watches.json"))!;
    // Deleting the last entry and leaving its comma behind.
    const broken = before.replace(/,\n {2}\{"id": "w2".*\n/u, ",\n");
    const refused = await run("Write", { file_path: "~/watches.json", content: broken }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^error: watches\.json line \d+, column \d+: /u);
    expect(await herFile(w, "aria", "home/watches.json")).toBe(before);
    const past = await run("Edit", { file_path: "~/watches.json", old_string: /"timeout": "[^"]+"/u.exec(before)![0], new_string: '"timeout": "2026-10-20 10:00"' }, ctx);
    expect(text(past)).toBe("error: watches.json entry w1: timeout is in the past");
    expect((await run("Edit", { file_path: "~/watches.json", old_string: /,\n {2}\{"id": "w2".*\n/u.exec(before)![0], new_string: "\n" }, ctx)).isError).toBeFalsy();
    expect(JSON.parse((await herFile(w, "aria", "home/watches.json"))!)).toHaveLength(1);
  });
});

describe("ScheduleWake and ~/schedule.json (§16.4)", () => {
  it("takes exactly one of at / in_minutes, 5 minutes to 30 days ahead, at most 20, saved in her file", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const schedule = (input: Record<string, unknown>) => run("ScheduleWake", { note: "n", ...input }, ctx);
    expect((await schedule({})).content).toBe("error: give exactly one of at or in_minutes");
    expect((await schedule({ at: "2026-10-25 18:00", in_minutes: 10 })).isError).toBe(true);
    expect(await schedule({ in_minutes: 4 })).toEqual({ content: "error: reminders must be at least 5 minutes ahead", isError: true });
    expect(await schedule({ at: "2026-12-01 10:00" })).toEqual({ content: "error: reminders can be at most 30 days ahead", isError: true });
    expect(await schedule({ at: "next tuesday" })).toEqual({ content: "error: use a local time like 2026-10-25 18:00", isError: true });
    expect(text(await schedule({ at: "2026-10-25 18:00", note: "ask Kevin about the exam", repeat: "weekly" }))).toBe("set r1 for Sun 25 Oct 18:00, then weekly (in ~/schedule.json)");
    for (let index = 2; index <= 20; index += 1) expect((await schedule({ in_minutes: 10 + index })).isError).toBeFalsy();
    expect(await schedule({ in_minutes: 60 })).toEqual({ content: "error: you already have 20 reminders; remove one from ~/schedule.json first", isError: true });
    const file = JSON.parse((await herFile(w, "aria", "home/schedule.json"))!) as Array<Record<string, unknown>>;
    expect(file[0]).toEqual({ id: "r1", at: "2026-10-25 18:00", repeat: "weekly", note: "ask Kevin about the exam" });
    expect(file).toHaveLength(20);
    // A hand-written entry without an id gets the next one; a bad field is refused.
    const entries = file.slice(1);
    expect(text(await run("Write", { file_path: "~/schedule.json", content: JSON.stringify([...entries, { at: "2026-10-26 09:00", note: "new" }]) }, ctx))).toMatch(/new entries got ids/u);
    expect((JSON.parse((await herFile(w, "aria", "home/schedule.json"))!) as Array<{ id: string }>).pop()!.id).toBe("r21");
    expect(text(await run("Write", { file_path: "~/schedule.json", content: JSON.stringify([{ at: "2026-10-26 09:00", note: "x", repeat: "hourly" }]) }, ctx))).toMatch(/^error: schedule\.json entry 1: /u);
  });
});

describe("Read, Write, Edit and the path rules (§16.2, §16.3.3, §16.3.4)", { timeout: 60_000 }, () => {
  it("enforces the path rules on every path form", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    for (const good of ["MEMORY.md", "~/me.md", "/home/aria/people/kevin.md", "places/bake-club/recipes.md", "/tmp/scratch.txt", "people/../notes.txt", "~/a/b/c/d/e/f/g.md"]) {
      expect((await run("Write", { file_path: good, content: "# x\n" }, ctx)).isError, good).toBeFalsy();
    }
    for (const bad of ["/etc/passwd", "../me.md", "~/../mina/x.md", "/home/mina/x.md", "/tmp/../home/aria/x.md/..", "a\\b.md", "con.txt", "people/NUL", "~/a/b/c/d/e/f/g/h/i.md", `${"x".repeat(101)}.md`, "", "~", "/tmp"]) {
      expect((await run("Write", { file_path: bad, content: "x" }, ctx)).isError, bad).toBe(true);
    }
    // Two names that differ only by case are refused (case-insensitive disks).
    expect(text(await run("Write", { file_path: "~/People/x.md", content: "x" }, ctx))).toMatch(/two names can't differ only by case/u);
    expect(text(await run("Write", { file_path: "~/me.MD", content: "x" }, ctx))).toMatch(/two names can't differ only by case/u);
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
    expect((await run("Read", { file_path: "~/rootlink/user/waifus/aria/home/real.md" }, ctx)).isError).toBe(true);
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
    expect(await herFile(w, "aria", "home/people/kevin.md")).toBe("# Kevin\n- loves tea\n- loves coffee now\n");
    expect(text(await run("Write", { file_path: "~/empty.md", content: "" }, ctx))).toBe("wrote ~/empty.md (0 B)");
    expect(text(await run("Read", { file_path: "~/empty.md" }, ctx))).toBe("(empty file)");
    expect(text(await run("Read", { file_path: "~/missing.md" }, ctx))).toBe("error: ~/missing.md doesn't exist");
    await refreshPlacesFile(w.cast.deps, ctx.waifu);
    expect(text(await run("Read", { file_path: "~/places.md" }, ctx))).toContain("bake-club/#general");
    for (const [tool, input] of [
      ["Write", { file_path: "~/places.md", content: "x" }],
      ["Edit", { file_path: "~/places.md", old_string: "Rooms", new_string: "x" }]
    ] as const) {
      expect(await run(tool, input, ctx)).toEqual({ content: "error: places.md is kept up to date for you and can't be changed", isError: true });
    }
    expect(text(await run("Bash", { command: "rm ~/places.md" }, ctx))).toMatch(/places\.md/u);
    expect(await herFile(w, "aria", "home/places.md")).toContain("# Your places");
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
  it("offers the eleven tools; web tools only while their caps allow; Bash only while enabled", async () => {
    const w = await lifeWorld(roots);
    expect(offeredToolNames(w.cast.deps)).toEqual(["ReadMessages", "SendMessage", "React", "WatchFor", "ScheduleWake", "Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"]);
    w.setConfig((config) => ({ ...config, search: { ...config.search, maxPerDay: 0 }, life: { ...config.life, webFetch: { ...config.life.webFetch, maxPerTurn: 0 }, bash: { ...config.life.bash, enabled: false } } }));
    expect(offeredToolNames(w.cast.deps)).toEqual(["ReadMessages", "SendMessage", "React", "WatchFor", "ScheduleWake", "Read", "Write", "Edit"]);
    for (const retired of ["list_places", "write_note", "list_watches", "cancel_wake", "send_message"]) expect(lifeTool(retired)).toBeUndefined();
  });

  it("~/places.md lists her rooms and private chats by handle", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    const ctx = await ctxFor(w);
    expect(await refreshPlacesFile(w.cast.deps, ctx.waifu)).toBe(true);
    // Unchanged: not rewritten.
    expect(await refreshPlacesFile(w.cast.deps, ctx.waifu)).toBe(false);
    const listed = (await herFile(w, "aria", "home/places.md"))!;
    expect(listed).toMatch(/^# Your places\n\(This file is kept up to date for you/u);
    expect(listed).toContain("- bake-club/#general (Bake Club › #general)");
    expect(listed).toContain("- bake-club/#recipes");
    expect(listed).toContain("- dm/kevin (Kevin)");
  });
});
