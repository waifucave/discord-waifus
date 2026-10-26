// Transcripts (Living cast spec §18.2, §18.3, §18.7): the shared store fed by the conversation
// cache's events, access intervals, DM isolation, her read-only `/transcripts` through Read and
// Bash (mounted lazily, never copied), and the write refusals.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationCacheEvent } from "../src/discord/conversationCache.js";
import { selfAuthorIds } from "../src/life/people.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext } from "../src/life/tools/types.js";
import {
  addTranscriptLine,
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
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

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

  it("renders a day as HH:MM Name ↩ref: text [file: …], her lines as you, no ids", async () => {
    const { w, writer } = await world();
    const hi = w.discord.post(ROOM, "who wants cake?", { attachments: [{ id: "900000000000000001", url: "https://cdn.discordapp.com/a/cake.png", filename: "cake.png", size: 10 }] });
    await feed(writer, create(ROOM, hi));
    await feed(writer, create(ROOM, w.discord.post(ROOM, "me!", { authorId: ELLA_BOT, authorName: "Ella", bot: true, replyTo: hi.id }), true));
    const text = (await new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: "UTC", now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"]))!;
    expect(text).toBe("# bake-club/#general · Sat 24 Oct 2026\n14:00 Kevin: who wants cake? [file: cake.png]\n14:00 you ↩Kevin: me!\n");
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
    expect((await run(w, "Bash", { command: "grep -rn Lianne /transcripts" })).text).toContain("/transcripts/bake-club/general/2026-10-24.md:3:14:00 Lianne: Lianne says hi");
    expect((await run(w, "Bash", { command: "cat /transcripts/bake-club/general/2026-10-24.md | wc -l" })).text).toBe("3\nexit 0");
    expect((await run(w, "Bash", { command: "python3 -c \"print(open('/transcripts/bake-club/general/2026-10-24.md').read().count('kingdom'))\"" }, "ella")).text).toBe("1\nexit 0");
    const read = await run(w, "Read", { file_path: "/transcripts/bake-club/general/2026-10-24.md" });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Lianne says hi");
    // A copy into her home is hers.
    expect((await run(w, "Bash", { command: "cp /transcripts/bake-club/general/2026-10-24.md ~/quote.md && head -1 ~/quote.md" })).text).toContain("changed: ~/quote.md");
  }, 60_000);

  it("refuses every write to /transcripts", async () => {
    const w = await seeded();
    expect(await run(w, "Write", { file_path: "/transcripts/x.md", content: "x" })).toEqual({ text: "error: transcripts are read-only", isError: true });
    expect(await run(w, "Edit", { file_path: "/transcripts/bake-club/general/2026-10-24.md", old_string: "hi", new_string: "bye" })).toEqual({ text: "error: transcripts are read-only", isError: true });
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
    const result = await run(w, "SendMessage", { place: "bake-club/#general", text: "look", files: ["/transcripts/bake-club/general/2026-10-24.md"] });
    expect(result.text).toContain("transcripts can't be attached");
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
    expect(result.text).toBe(`hi\n120\n12:00 Kevin: ${filler} 0\nexit 0`);
    // A copy of the store would be read in full; this reads one day of 120.
    expect(elapsed).toBeLessThan(10_000);
    expect(process.memoryUsage.rss() - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);
});
