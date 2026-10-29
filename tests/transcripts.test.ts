// Transcripts (Living cast spec §18.2, §18.3, §18.7): the shared store fed by the conversation
// cache's events, access intervals, DM isolation, her read-only `/transcripts` through Read and
// Bash (mounted lazily, never copied), and the write refusals.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationCacheEvent } from "../src/discord/conversationCache.js";
import { selfAuthorIds } from "../src/life/people.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import { TRANSCRIPT_COPY_REASON } from "../src/life/tools/messages.js";
import { homeStoreFor } from "../src/life/home/index.js";
import type { ToolContext } from "../src/life/tools/types.js";
import {
  addTranscriptLine,
  deleteTranscriptLines,
  DELETED_MEMORY_MS,
  forgetTranscriptAtOrBelow,
  scrubTranscriptLines,
  listTranscriptDays,
  readTranscriptAccess,
  readTranscriptDay,
  settleTranscripts,
  transcriptsStartedAt
} from "../src/life/transcripts/store.js";
import { TranscriptView } from "../src/life/transcripts/view.js";
import { TranscriptWriter } from "../src/life/transcripts/writer.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { recordForgottenPerson } from "../src/orchestration/dm/forgotten.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, scriptInput, updateFilePatch } from "./toolCalls.js";

const roots: string[] = [];

afterEach(async () => {
  await settleTranscripts();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function world(o: Parameters<typeof lifeWorld>[1] = {}): Promise<{ w: LifeWorld; writer: TranscriptWriter }> {
  const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }, { id: "mina", name: "Mina", botId: "mina-bot" }], cast: ["ella"], ...o });
  const writer = new TranscriptWriter(w.cast.deps);
  await writer.start();
  return { w, writer };
}

async function feed(writer: TranscriptWriter, event: ConversationCacheEvent): Promise<void> {
  writer.onCacheEvent(event);
  await writer.settle();
}

function create(conversation: ConversationRef, message: RawDiscordMessage, own = false): ConversationCacheEvent {
  return { type: "create", conversation, message, own };
}

async function setCast(w: LifeWorld, cast: string[]): Promise<void> {
  const file = `user/servers/${GUILD}/server.json`;
  const server = await w.storage.readJson(file, ServerConfigSchema);
  await w.storage.writeJson(`server:${GUILD}`, file, ServerConfigSchema, { ...server, channels: { ...server.channels, [CHANNEL]: { ...server.channels[CHANNEL]!, enabledWaifuIds: cast } } });
}

async function toolCtx(w: LifeWorld, waifuId = "ella"): Promise<ToolContext> {
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

async function run(w: LifeWorld, tool: string, input: unknown, waifuId = "ella"): Promise<{ text: string; isError: boolean }> {
  const output = await lifeTool(tool)!.run(input, await toolCtx(w, waifuId));
  return { text: typeof output.content === "string" ? output.content : JSON.stringify(output.content), isError: output.isError === true };
}

describe("the transcript store", () => {
  it("records messages, our sends, edits and deletes, one line per message per local day", async () => {
    const { w, writer } = await world();
    const hello = w.discord.post(ROOM, "hello <@300000000000000004>", { mentions: { [MINA_USER]: "Mina" } });
    await feed(writer, create(ROOM, hello));
    const sent = w.discord.post(ROOM, "hi Kevin!", { authorId: ELLA_BOT, authorName: "Ella", bot: true, replyTo: hello.id });
    await feed(writer, create(ROOM, sent, true));
    // Delivered twice (the sender publishes, then the gateway): one line.
    await feed(writer, create(ROOM, sent));
    const day = "2026-10-24";
    let lines = await readTranscriptDay(w.root, ROOM_KEY, day);
    expect(lines.map((line) => [line.author, line.text, line.waifu])).toEqual([
      ["Kevin", "hello @Mina", undefined],
      ["Ella", "hi Kevin!", "ella"]
    ]);
    expect(lines[0]!.mentions).toEqual([MINA_USER]);
    expect(lines[1]!.reply).toBe(hello.id);
    await feed(writer, { type: "update", conversation: ROOM, message: { ...hello, content: "hello all", editedAt: new Date(w.clock.ms).toISOString() }, source: "gateway" });
    lines = await readTranscriptDay(w.root, ROOM_KEY, day);
    expect(lines[0]).toMatchObject({ text: "hello all", edited: true });
    await feed(writer, { type: "delete", conversation: ROOM, messageId: hello.id, source: "gateway" });
    lines = await readTranscriptDay(w.root, ROOM_KEY, day);
    expect(lines.map((line) => line.id)).toEqual([sent.id]);
    // A stale REST page never brings a deleted message back.
    await feed(writer, { type: "page", conversation: ROOM, messages: [hello, sent] });
    expect((await readTranscriptDay(w.root, ROOM_KEY, day)).map((line) => line.id)).toEqual([sent.id]);
  });

  it("fills gaps from REST pages by message id, never twice, in order", async () => {
    const { w, writer } = await world();
    const a = w.discord.post(ROOM, "one");
    const b = w.discord.post(ROOM, "two");
    const c = w.discord.post(ROOM, "three");
    await feed(writer, create(ROOM, c));
    await feed(writer, { type: "page", conversation: ROOM, messages: [a, b, c] });
    await feed(writer, { type: "page", conversation: ROOM, messages: [a, b, c] });
    const lines = await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24");
    expect(lines.map((line) => line.text)).toEqual(["one", "two", "three"]);
    const raw = await readFile(path.join(w.root, "user", "transcripts", ROOM_KEY, "2026-10-24.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("an update that is not an edit (an embed unfurl, a pin) changes nothing; an edit stays marked", async () => {
    const { w, writer } = await world();
    const hello = w.discord.post(ROOM, "look https://example.com");
    await feed(writer, create(ROOM, hello));
    const file = path.join(w.root, "user", "transcripts", ROOM_KEY, "2026-10-24.jsonl");
    const before = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await feed(writer, { type: "update", conversation: ROOM, message: { ...hello, pinned: true } as never, source: "gateway" });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24"))[0]!.edited).toBeUndefined();
    await feed(writer, { type: "update", conversation: ROOM, message: { ...hello, content: "look at this", editedAt: new Date(w.clock.ms).toISOString() }, source: "gateway" });
    // A later unfurl of the edited message keeps its mark.
    await feed(writer, { type: "update", conversation: ROOM, message: { ...hello, content: "look at this" }, source: "gateway" });
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24"))[0]).toMatchObject({ text: "look at this", edited: true });
  });

  it("after a torn last line, the next line starts on its own line", async () => {
    const { w } = await world();
    const env = { dataRoot: w.root, timeZone: "UTC" };
    const line = (id: string, minute: number) => ({ id, at: `2026-10-24T12:${String(minute).padStart(2, "0")}:00.000Z`, authorId: KEVIN, author: "Kevin", text: `line ${id}` });
    expect(await addTranscriptLine(env, ROOM_KEY, line("1", 1))).toBe("added");
    const file = path.join(w.root, "user", "transcripts", ROOM_KEY, "2026-10-24.jsonl");
    // A crash in the middle of the next append.
    await writeFile(file, `${await readFile(file, "utf8")}{"id":"2","at":"2026-10-24T12:0`);
    expect(await addTranscriptLine(env, ROOM_KEY, line("3", 3))).toBe("added");
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24")).map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(await addTranscriptLine(env, ROOM_KEY, line("3", 3))).toBe("exists");
  });

  it("a Discord delete is remembered a day, a forget for good; a DM floor keeps the ids above it", async () => {
    const { w } = await world();
    const env = { dataRoot: w.root, timeZone: "UTC" };
    const line = (id: string) => ({ id, at: "2026-10-24T12:00:00.000Z", authorId: KEVIN, author: "Kevin", text: `line ${id}` });
    await addTranscriptLine(env, ROOM_KEY, line("10"));
    await addTranscriptLine(env, ROOM_KEY, line("20"));
    await deleteTranscriptLines(env, ROOM_KEY, ["10"]);
    await scrubTranscriptLines(env, ROOM_KEY, (entry) => entry.id === "20");
    expect(await addTranscriptLine(env, ROOM_KEY, line("10"))).toBe("skipped");
    expect(await addTranscriptLine(env, ROOM_KEY, line("20"))).toBe("skipped");
    const meta = path.join(w.root, "user", "transcripts", ROOM_KEY, "meta.json");
    const stored = JSON.parse(await readFile(meta, "utf8")) as { removed: string[]; deleted: Record<string, string> };
    expect(stored.removed).toEqual(["20"]);
    // A day later the delete is forgotten (a message that came back is Discord's again); the forget is not.
    await writeFile(meta, JSON.stringify({ ...stored, deleted: { "10": new Date(Date.now() - DELETED_MEMORY_MS - 1_000).toISOString() } }));
    expect(await addTranscriptLine(env, ROOM_KEY, line("10"))).toBe("added");
    expect(await addTranscriptLine(env, ROOM_KEY, line("20"))).toBe("skipped");
    // A DM floor below a forgotten id keeps it.
    const dmKey = conversationKey(dmOf("ella"));
    await addTranscriptLine(env, dmKey, line("30"));
    await scrubTranscriptLines(env, dmKey, (entry) => entry.id === "30");
    await forgetTranscriptAtOrBelow(env, dmKey, "25");
    expect(await addTranscriptLine(env, dmKey, line("30"))).toBe("skipped");
    expect(await addTranscriptLine(env, dmKey, line("24"))).toBe("skipped");
  });

  it("splits days in the host time zone and writes nothing from before the store started", async () => {
    const { w } = await world();
    const env = { dataRoot: w.root, timeZone: "America/New_York" };
    const startedAt = await transcriptsStartedAt(w.root, w.clock.now());
    const line = (id: string, at: string) => ({ id, at, authorId: KEVIN, author: "Kevin", text: id });
    // 02:30 UTC on the 25th is still the 24th in New York.
    expect(await addTranscriptLine(env, ROOM_KEY, line("1", "2026-10-25T02:30:00.000Z"), { startedAt })).toBe("added");
    expect(await addTranscriptLine(env, ROOM_KEY, line("2", "2026-10-25T05:30:00.000Z"), { startedAt })).toBe("added");
    expect(await addTranscriptLine(env, ROOM_KEY, line("0", "2026-10-20T12:00:00.000Z"), { startedAt })).toBe("skipped");
    expect(await listTranscriptDays(w.root, ROOM_KEY)).toEqual(["2026-10-24", "2026-10-25"]);
  });

  it("keeps rooms without a cast out, and records who was cast when (joined later, removed earlier)", async () => {
    const { w, writer } = await world();
    const elsewhere: ConversationRef = { kind: "guild", guildId: GUILD, channelId: "299999999999999999" };
    await feed(writer, create(elsewhere, w.discord.post(elsewhere, "nobody cast here")));
    expect(await listTranscriptDays(w.root, conversationKey(elsewhere))).toEqual([]);
    await feed(writer, create(ROOM, w.discord.post(ROOM, "before Mina")));
    w.clock.advance(60_000);
    await setCast(w, ["ella", "mina"]);
    await feed(writer, create(ROOM, w.discord.post(ROOM, "Mina is here")));
    w.clock.advance(60_000);
    await setCast(w, ["mina"]);
    await feed(writer, create(ROOM, w.discord.post(ROOM, "Ella left")));
    const ella = (await readTranscriptAccess(w.root, "ella")).conversations[ROOM_KEY]!;
    const mina = (await readTranscriptAccess(w.root, "mina")).conversations[ROOM_KEY]!;
    expect(ella).toHaveLength(1);
    expect(ella[0]!.to).toBeDefined();
    expect(mina).toHaveLength(1);
    expect(mina[0]!.to).toBeUndefined();
    const text = async (waifuId: string) => (await new TranscriptView({ storage: w.storage, waifuId, timeZone: "UTC", now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"])) ?? "";
    expect(await text("ella")).toContain("before Mina");
    expect(await text("ella")).toContain("Mina is here");
    expect(await text("ella")).not.toContain("Ella left");
    expect(await text("mina")).not.toContain("before Mina");
    expect(await text("mina")).toContain("Mina is here");
    expect(await text("mina")).toContain("Ella left");
  });

  it("a removal while the app was down closes her interval at the last line written, not at the restart", async () => {
    const { w, writer } = await world();
    await setCast(w, ["ella", "mina"]);
    await feed(writer, create(ROOM, w.discord.post(ROOM, "both here")));
    await writer.close();
    // Down for an hour: Ella was taken out of the room meanwhile, and people kept talking.
    w.clock.advance(30 * 60_000);
    const during = w.discord.post(ROOM, "said while the app was down");
    w.clock.advance(30 * 60_000);
    await setCast(w, ["mina"]);
    const restarted = new TranscriptWriter(w.cast.deps);
    await restarted.start();
    await feed(restarted, { type: "page", conversation: ROOM, messages: [during] });
    const text = async (waifuId: string) => (await new TranscriptView({ storage: w.storage, waifuId, timeZone: "UTC", now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"])) ?? "";
    expect(await text("mina")).toContain("said while the app was down");
    expect(await text("ella")).toContain("both here");
    expect(await text("ella")).not.toContain("said while the app was down");
  });

  it("a catch-up never writes a line from before a forget that mentions the forgotten person", async () => {
    const { w, writer } = await world();
    const before = w.discord.post(ROOM, `<@${KEVIN}> passed his exam`, { authorId: MINA_USER, authorName: "Mina", mentions: { [KEVIN]: "Kevin" } });
    const plain = w.discord.post(ROOM, "the oven is ready", { authorId: MINA_USER, authorName: "Mina" });
    w.clock.advance(60_000);
    await recordForgottenPerson(w.storage, KEVIN, w.clock.now());
    writer.noteForget();
    w.clock.advance(60_000);
    const after = w.discord.post(ROOM, `<@${KEVIN}> welcome back`, { authorId: MINA_USER, authorName: "Mina", mentions: { [KEVIN]: "Kevin" } });
    await feed(writer, { type: "page", conversation: ROOM, messages: [before, plain, after] });
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24")).map((line) => line.text)).toEqual(["the oven is ready", "@Kevin welcome back"]);
  });

  it("shows a DM only to the waifu whose DM it is", async () => {
    const { w, writer } = await world();
    const dm = dmOf("ella");
    await feed(writer, create(dm, w.discord.post(dm, "a secret for Ella")));
    const ella = new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: "UTC", now: w.clock.now });
    const mina = new TranscriptView({ storage: w.storage, waifuId: "mina", timeZone: "UTC", now: w.clock.now });
    expect((await ella.readdir([]))?.map((entry) => entry.name)).toContain("dm");
    expect((await ella.readdir(["dm"]))?.map((entry) => entry.name)).toEqual(["user-0003"]);
    expect(await ella.read(["dm", "user-0003", "2026-10-24.md"])).toContain("Kevin: a secret for Ella");
    expect(await ella.isPrivate(["dm", "user-0003", "2026-10-24.md"])).toBe(true);
    expect(await mina.readdir(["dm"])).toBeUndefined();
    expect(await mina.read(["dm", "user-0003", "2026-10-24.md"])).toBeUndefined();
  });

  it("renders a day as [HH:MM #ref] Name ↩#ref: text [file: …] with refs given at ingest, her lines as you, no ids (§22.1)", async () => {
    const { w, writer } = await world();
    const hi = w.discord.post(ROOM, "who wants cake?", { attachments: [{ id: "900000000000000001", url: "https://cdn.discordapp.com/a/cake.png", filename: "cake.png", size: 10 }] });
    await feed(writer, create(ROOM, hi));
    await feed(writer, create(ROOM, w.discord.post(ROOM, "me!", { authorId: ELLA_BOT, authorName: "Ella", bot: true, replyTo: hi.id }), true));
    const text = (await new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: "UTC", now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"]))!;
    expect(text).toBe("# bake-club/#general · Sat 24 Oct 2026\n[14:00 #a0] Kevin: who wants cake? [file: cake.png]\n[14:00 #a1] you ↩#a0: me!\n");
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24")).map((line) => line.ref)).toEqual(["a0", "a1"]);
    expect(text).not.toContain(hi.id);
  });
});

describe("/transcripts in her computer", () => {
  async function seeded() {
    const { w, writer } = await world();
    await feed(writer, create(ROOM, w.discord.post(ROOM, "the bake sale is in #secret-room on kingdom-16062")));
    await feed(writer, create(ROOM, w.discord.post(ROOM, "Lianne says hi", { authorId: MINA_USER, authorName: "Lianne" })));
    return w;
  }

  it("lists, reads and greps it with Read and Bash", async () => {
    const w = await seeded();
    expect((await run(w, "Bash", { command: "ls /" })).text).toBe("home\ntmp\ntranscripts\nexit 0");
    expect((await run(w, "Bash", { command: "ls /transcripts/bake-club/general" })).text).toBe("2026-10-24.md\nexit 0");
    expect((await run(w, "Bash", { command: "grep -rn Lianne /transcripts" })).text).toContain("/transcripts/bake-club/general/2026-10-24.md:3:[14:00 #a1] Lianne: Lianne says hi");
    expect((await run(w, "Bash", { command: "cat /transcripts/bake-club/general/2026-10-24.md | wc -l" })).text).toBe("3\nexit 0");
    expect((await run(w, "Bash", { command: "python3 -c \"print(open('/transcripts/bake-club/general/2026-10-24.md').read().count('kingdom'))\"" }, "ella")).text).toBe("1\nexit 0");
    const read = await run(w, "Read", scriptInput.readFile("/transcripts/bake-club/general/2026-10-24.md"));
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Lianne says hi");
    // A copy into her home is hers.
    expect((await run(w, "Bash", { command: "cp /transcripts/bake-club/general/2026-10-24.md ~/quote.md && head -1 ~/quote.md" })).text).toContain("changed: ~/quote.md");
  }, 60_000);

  it("refuses every write to /transcripts", async () => {
    const w = await seeded();
    const refused = (file: string) => ({ text: `error: Error: apply_patch: ${file}: transcripts are read-only; nothing was changed (line 1)`, isError: true });
    expect(await run(w, "Edit", scriptInput.applyPatch(addFilePatch("/transcripts/x.md", "x")))).toEqual(refused("/transcripts/x.md"));
    const day = "/transcripts/bake-club/general/2026-10-24.md";
    expect(await run(w, "Edit", scriptInput.applyPatch(updateFilePatch(day, ["hi", "bye"])))).toEqual(refused(day));
    expect(await run(w, "Edit", scriptInput.applyPatch(`*** Begin Patch\n*** Delete File: ${day}\n*** End Patch`))).toEqual(refused(day));
    // Moving a file of hers there is refused too.
    expect(await run(w, "Edit", scriptInput.applyPatch(`${addFilePatch("~/n.md", "x").replace("\n*** End Patch", "")}\n*** End Patch`))).toEqual({ text: "Updated: A ~/n.md", isError: false });
    expect(await run(w, "Edit", scriptInput.applyPatch("*** Begin Patch\n*** Update File: ~/n.md\n*** Move to: /transcripts/n.md\n@@\n-x\n+y\n*** End Patch"))).toEqual(refused("/transcripts/n.md"));
    // The retired Write still refuses.
    expect(await run(w, "Write", { file_path: "/transcripts/x.md", content: "x" })).toEqual({ text: "error: transcripts are read-only", isError: true });
    for (const command of ["echo x > /transcripts/x.md", "rm /transcripts/bake-club/general/2026-10-24.md", "mv /transcripts/bake-club ~/x", "mkdir /transcripts/new", "touch /transcripts/bake-club/general/2026-10-24.md"]) {
      const result = await run(w, "Bash", { command });
      expect(result.text, command).toContain("transcripts are read-only");
      expect(result.text, command).not.toContain("changed:");
    }
    expect((await run(w, "Bash", { command: "ls /transcripts/bake-club/general" })).text).toBe("2026-10-24.md\nexit 0");
    expect(await listTranscriptDays(w.root, ROOM_KEY)).toEqual(["2026-10-24"]);
  }, 60_000);

  it("is never attached by SendMessage", async () => {
    const w = await seeded();
    const result = await run(w, "SendMessage", scriptInput.sendMessage("bake-club/#general", [{ text: "look", attach: "/transcripts/bake-club/general/2026-10-24.md" }]));
    expect(result.text).toContain("transcripts can't be attached");
    expect(w.discord.sent.at(-1)?.files).toBeUndefined();
  }, 60_000);

  it("a copy of a DM transcript in her home keeps its DM origin and is never attached (D14)", async () => {
    const { w, writer } = await world();
    const dm = dmOf("ella");
    await feed(writer, create(dm, w.discord.post(dm, "a secret for Ella")));
    const key = conversationKey(dm);
    const day = "/transcripts/dm/user-0003/2026-10-24.md";
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    await run(w, "Bash", { command: `cp ${day} ~/copy.md && cat ${day} > ~/cat.md` });
    expect(await store.dmOrigin((await store.resolveExisting("~/copy.md")).path!)).toBe(key);
    expect(await store.dmOrigin((await store.resolveExisting("~/cat.md")).path!)).toBe(key);
    // Read, then a patch adding exactly what it showed, in one turn.
    const ctx = await toolCtx(w);
    await lifeTool("Read")!.run(scriptInput.readFile(day), ctx);
    const text = (await new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: "UTC", now: w.clock.now }).read(["dm", "user-0003", "2026-10-24.md"]))!;
    expect(text.endsWith("\n")).toBe(true);
    expect((await lifeTool("Edit")!.run(scriptInput.applyPatch(addFilePatch("~/written.md", text)), ctx)).isError).toBeFalsy();
    expect(await store.dmOrigin((await store.resolveExisting("~/written.md")).path!)).toBe(key);
    // Her own words about it are hers.
    await run(w, "Edit", scriptInput.applyPatch(addFilePatch("~/mine.md", "Kevin told me something")));
    expect(await store.dmOrigin((await store.resolveExisting("~/mine.md")).path!)).toBeUndefined();
    const sent = await run(w, "SendMessage", scriptInput.sendMessage("bake-club/#general", [{ text: "look", attach: ["~/copy.md", "~/written.md"] }]));
    expect(sent.text).toContain(TRANSCRIPT_COPY_REASON);
    expect(w.discord.sent.at(-1)?.files).toBeUndefined();
  }, 60_000);

  it("is mounted lazily: a command over a large store never copies it", async () => {
    const { w } = await world();
    // 120 days × 400 lines (~10 MB of JSONL) in one room.
    const dir = path.join(w.root, "user", "transcripts", ROOM_KEY);
    await mkdir(dir, { recursive: true });
    const filler = "x".repeat(180);
    for (let d = 0; d < 120; d += 1) {
      const day = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
      const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: `${d}-${i}`, at: `${day}T12:${String(i % 60).padStart(2, "0")}:00.000Z`, authorId: KEVIN, author: "Kevin", text: `${filler} ${i}` }));
      await writeFile(path.join(dir, `${day}.jsonl`), `${lines.join("\n")}\n`);
    }
    await mkdir(path.join(w.root, "user", "transcripts", "access"), { recursive: true });
    await writeFile(path.join(w.root, "user", "transcripts", "access", "ella.json"), JSON.stringify({ conversations: { [ROOM_KEY]: [{ from: "2026-06-01T00:00:00.000Z" }] } }));
    expect((await readdir(dir)).length).toBe(120);
    const before = process.memoryUsage.rss();
    const started = Date.now();
    const result = await run(w, "Bash", { command: "echo hi && ls /transcripts/bake-club/general | wc -l && head -2 /transcripts/bake-club/general/2026-07-01.md | tail -1" });
    const elapsed = Date.now() - started;
    expect(result.text).toBe(`hi\n120\n[12:00] Kevin: ${filler} 0\nexit 0`);
    // A copy of the store would be read in full; this reads one day of 120.
    expect(elapsed).toBeLessThan(10_000);
    expect(process.memoryUsage.rss() - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);
});
