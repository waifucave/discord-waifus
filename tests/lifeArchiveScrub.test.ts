// Forget scrubs the Living cast archive too (spec §7.5, owner decision D-b): the owner's forget-user
// takes everything under `user/.archive/living-cast/` (best effort), a waifu's own scrub takes her
// slice; `providers.json` and `models/` are never touched; unreadable files are left and counted.
// The owner's forget-user also drops the person from member and participant lists and clears the
// in-memory captured traffic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scrubArchive } from "../src/life/archiveScrub.js";
import { forgetUser } from "../src/orchestration/dm/forgetUser.js";
import { onCapturedTrafficForgotten, recentQueries, recordProviderQuery } from "../src/shared/queryLog.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const KEVIN = "300000000000000003";
const MINA = "300000000000000004";
const SAM = "300000000000000005";
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const T = "2026-10-01T12:00:00.000Z";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function write(root: string, relative: string, value: unknown): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const read = async (root: string, relative: string) => JSON.parse(await readFile(path.join(root, relative), "utf8")) as Record<string, unknown>;
const A = "user/.archive/living-cast";

/** An archive as L1's migrations leave it, with Kevin in every kind of file. */
async function archivedRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const memory = (id: string, waifuId: string, content: string, o: Record<string, unknown> = {}) => ({ id, waifuId, content, status: "active", subjects: [], origin: {}, ...o });
  await write(root, `${A}/memories.json`, {
    schemaVersion: 2,
    revision: 7,
    memories: [
      memory("k1", "aria", "Studies chemistry.", { subjects: [{ discordUserId: KEVIN, name: "Kevin" }] }),
      memory("k2", "aria", "Going through a divorce.", { origin: { dm: true, userId: KEVIN } }),
      memory("k3", "mina", "Kevin hates jazz.", { subjects: [] }),
      memory("m1", "aria", "Mina runs the bake sale.", { subjects: [{ discordUserId: MINA, name: "Mina" }] }),
      memory("s1", "aria", "Sam likes jazz.", { subjects: [{ discordUserId: SAM, name: "Sam" }] }),
      memory("k4", "mina", "Kev's cat is called Biscuit.", { subjects: [{ discordUserId: KEVIN, name: "Kev" }] })
    ]
  });
  await write(root, `${A}/notes-omitted/aria.json`, {
    waifuId: "aria",
    omitted: [
      { path: "people/kevin.md", recordId: "k1", line: "Studies chemistry.", why: "note_limit" },
      { path: "misc.md", recordId: "x9", line: "The bake sale is Saturday.", why: "note_limit" }
    ]
  });
  await write(root, `${A}/notes-omitted/mina.json`, { waifuId: "mina", omitted: [{ path: "people/kev.md", recordId: "k4", line: "Kev's cat is called Biscuit.", why: "note_limit" }] });
  await write(root, `${A}/memory/pending-observations.json`, {
    observations: [
      { id: "o1", waifuId: "aria", text: "asked about the exam", subjects: [{ discordUserId: KEVIN, name: "Kevin" }] },
      { id: "o2", waifuId: "mina", text: "about the bake sale", subjects: [{ discordUserId: MINA, name: "Mina" }] }
    ]
  });
  await write(root, `${A}/memory/dream-cursor.json`, { lastDreamAt: T, cursors: { [`dm_${KEVIN}_aria`]: "900", [`g_${GUILD}_${CHANNEL}`]: "901" } });
  await write(root, `${A}/conversations/g_${GUILD}_${CHANNEL}/ledger.json`, {
    entries: {
      m1: { authorId: KEVIN, content: "my exam is friday", images: [] },
      m2: { authorId: MINA, content: "good luck Kevin!", images: [] },
      m3: { authorId: MINA, content: "who brings cake?", images: [] }
    }
  });
  await write(root, `${A}/conversations/g_${GUILD}_${CHANNEL}/contexts/waifu-aria.json`, { epoch: 3, turns: [{ role: "user", text: `<@${KEVIN}> hi` }, { role: "assistant", text: "hello there" }] });
  await write(root, `${A}/conversations/dm_${KEVIN}_aria/ledger.json`, { entries: { d1: { authorId: KEVIN, content: "secret" } } });
  await write(root, `${A}/conversations/dm_${MINA}_aria/ledger.json`, { entries: { d1: { authorId: MINA, content: "hi" } } });
  // The L2 DM-state step's copies of the original DM states, filed under each user.
  await write(root, `${A}/dms/${KEVIN}/aria.json`, { waifuId: "aria", userId: KEVIN, userDisplayName: "Kev", pendingSince: T });
  await write(root, `${A}/dms/${KEVIN}/mina.json`, { waifuId: "mina", userId: KEVIN, recentRuns: [] });
  await write(root, `${A}/dms/${MINA}/aria.json`, { waifuId: "aria", userId: MINA, recentRuns: [] });
  await write(root, `${A}/servers/${GUILD}/orchestrator-history.json`, {
    decisions: [
      { id: "d1", createdAt: T, reason: "Kevin asked Aria", speakers: ["aria"] },
      { id: "d2", createdAt: T, reason: "Mina asked Mina", speakers: ["mina"] }
    ]
  });
  await write(root, `${A}/servers/${GUILD}/sessions/${CHANNEL}.json`, { participants: [{ userId: KEVIN, name: "Kevin" }, { userId: MINA, name: "Mina" }] });
  await write(root, `${A}/stage-manager/history.json`, { edits: [{ id: "e1", userId: KEVIN, note: "x" }, { id: "e2", userId: MINA, note: "y" }] });
  await write(root, `${A}/reviewer/history.json`, "{ torn");
  await write(root, `${A}/providers.json`, { providers: { openai: { apiKey: `key-for-${KEVIN}` } } });
  await write(root, `${A}/models/waifu-aria.json`, { note: `chosen while Kevin watched ${KEVIN}` });
  // Live files the owner's forget-user cleans too.
  await write(root, `user/servers/${GUILD}/members.json`, {
    schemaVersion: 2,
    revision: 1,
    updatedAt: T,
    guildId: GUILD,
    members: [
      { userId: KEVIN, username: "kevbaker", guildDisplayName: "Kevin", bot: false, perChannelLastSeenAt: {}, fetchedAt: T },
      { userId: MINA, username: "mina", bot: false, perChannelLastSeenAt: {}, fetchedAt: T }
    ]
  });
  await write(root, `user/servers/${GUILD}/active-chat-participants/${CHANNEL}.json`, {
    schemaVersion: 2,
    revision: 1,
    updatedAt: T,
    guildId: GUILD,
    channelId: CHANNEL,
    participants: [
      { userId: KEVIN, displayName: "Kevin", lastSeenAt: T, expiresAt: "2099-01-01T00:00:00.000Z" },
      { userId: MINA, displayName: "Mina", lastSeenAt: T, expiresAt: "2099-01-01T00:00:00.000Z" }
    ]
  });
  return root;
}

// Disk-bound (atomic JSON writes per step): about 1–3 s alone, up to 4× slower when the whole suite
// runs in parallel workers; the default 10 s timeout was too tight there.
describe("the archive scrub (D-b)", { timeout: 30_000 }, () => {
  it("the owner's forget-user scrubs the whole archive: records by or about him, by id or a name only he has", async () => {
    const root = await archivedRoot();
    const before = await readFile(path.join(root, A, "providers.json"), "utf8");
    const modelsBefore = await readFile(path.join(root, A, "models/waifu-aria.json"), "utf8");
    const result = await scrubArchive(root, { userId: KEVIN, names: ["Kevin"], avoidNames: ["Sam"] });
    expect(result.unreadable).toBe(1);

    expect(((await read(root, `${A}/memories.json`)).memories as Array<{ id: string }>).map((record) => record.id)).toEqual(["m1", "s1"]);
    expect((await read(root, `${A}/memories.json`)).revision).toBe(7);
    expect((await read(root, `${A}/notes-omitted/aria.json`)).omitted).toEqual([{ path: "misc.md", recordId: "x9", line: "The bake sale is Saturday.", why: "note_limit" }]);
    // His record's id drops the omitted line even though the line does not name him.
    expect((await read(root, `${A}/notes-omitted/mina.json`)).omitted).toEqual([]);
    expect(((await read(root, `${A}/memory/pending-observations.json`)).observations as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["o2"]);
    expect((await read(root, `${A}/memory/dream-cursor.json`)).cursors).toEqual({ [`g_${GUILD}_${CHANNEL}`]: "901" });
    expect(Object.keys((await read(root, `${A}/conversations/g_${GUILD}_${CHANNEL}/ledger.json`)).entries as object)).toEqual(["m3"]);
    expect((await read(root, `${A}/conversations/g_${GUILD}_${CHANNEL}/contexts/waifu-aria.json`)).turns).toEqual([{ role: "assistant", text: "hello there" }]);
    await expect(readFile(path.join(root, A, `conversations/dm_${KEVIN}_aria/ledger.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(root, `${A}/conversations/dm_${MINA}_aria/ledger.json`)).toEqual({ entries: { d1: { authorId: MINA, content: "hi" } } });
    // Everything filed under his id goes whole; Mina's copy stays.
    await expect(readFile(path.join(root, A, `dms/${KEVIN}/aria.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, A, `dms/${KEVIN}/mina.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(root, `${A}/dms/${MINA}/aria.json`)).toMatchObject({ userId: MINA });
    expect(((await read(root, `${A}/servers/${GUILD}/orchestrator-history.json`)).decisions as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["d2"]);
    expect((await read(root, `${A}/servers/${GUILD}/sessions/${CHANNEL}.json`)).participants).toEqual([{ userId: MINA, name: "Mina" }]);
    expect(((await read(root, `${A}/stage-manager/history.json`)).edits as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["e2"]);
    // Keys and model choices are never rewritten; a torn file is left as it is.
    expect(await readFile(path.join(root, A, "providers.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(root, A, "models/waifu-aria.json"), "utf8")).toBe(modelsBefore);
    expect(await readFile(path.join(root, A, "reviewer/history.json"), "utf8")).toBe("{ torn");
    // Nothing of him is left anywhere else.
    const again = await scrubArchive(root, { userId: KEVIN, names: ["Kevin"] });
    expect(again).toMatchObject({ files: 0, removed: 0 });
  });

  it("her own scrub takes only her slice: her records, her omitted lines, her observations, her DM with him", async () => {
    const root = await archivedRoot();
    await scrubArchive(root, { userId: KEVIN, names: ["Kevin"], waifuId: "aria" });
    expect(((await read(root, `${A}/memories.json`)).memories as Array<{ id: string }>).map((record) => record.id)).toEqual(["k3", "m1", "s1", "k4"]);
    // Her archived DM state with him goes; his DM state with Mina is the owner's forget-user's.
    await expect(readFile(path.join(root, A, `dms/${KEVIN}/aria.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(root, `${A}/dms/${KEVIN}/mina.json`)).toMatchObject({ waifuId: "mina" });
    expect((await read(root, `${A}/notes-omitted/aria.json`)).omitted).toHaveLength(1);
    expect((await read(root, `${A}/notes-omitted/mina.json`)).omitted).toHaveLength(1);
    expect(((await read(root, `${A}/memory/pending-observations.json`)).observations as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["o2"]);
    await expect(readFile(path.join(root, A, `conversations/dm_${KEVIN}_aria/ledger.json`))).rejects.toMatchObject({ code: "ENOENT" });
    // Shared archives (room ledgers, histories) are the owner's forget-user's to scrub.
    expect(Object.keys((await read(root, `${A}/conversations/g_${GUILD}_${CHANNEL}/ledger.json`)).entries as object)).toEqual(["m1", "m2", "m3"]);
  });

  it("names: a weak or shared name never removes anything, an archived subject's unique name does", async () => {
    const root = await archivedRoot();
    // No names given: "Kev" comes from his archived subjects; "Sam" belongs to someone else.
    await scrubArchive(root, { userId: SAM, names: ["Sam"] });
    // Sam is three characters: only his id-bound records go.
    expect(((await read(root, `${A}/memories.json`)).memories as Array<{ id: string }>).map((record) => record.id)).toEqual(["k1", "k2", "k3", "m1", "k4"]);
  });

  it("scrubs at once run one after the other, so none restores another's removals (third review, Important 3)", async () => {
    const memories = async (root: string) => ((await read(root, `${A}/memories.json`)).memories as Array<{ id: string }>).map((record) => record.id);
    // Two owner forgets at once.
    const root = await archivedRoot();
    const storage = new StorageService(root);
    await Promise.all([forgetUser(storage, { discordUserId: KEVIN, names: ["Kevin"] }), forgetUser(storage, { discordUserId: MINA, names: ["Mina"] })]);
    expect(await memories(root)).toEqual(["s1"]);
    // An owner forget and two DM users' slices at once give what one after the other gives.
    const scrubs = [{ userId: KEVIN, names: ["Kevin"] }, { userId: MINA, names: ["Mina"], waifuId: "aria" }, { userId: SAM, names: ["Sam"], waifuId: "aria" }];
    const together = await archivedRoot();
    await Promise.all(scrubs.map((input) => scrubArchive(together, input)));
    const inTurn = await archivedRoot();
    for (const input of scrubs) await scrubArchive(inTurn, input);
    expect(await memories(together)).toEqual(await memories(inTurn));
    expect(await memories(together)).not.toEqual(expect.arrayContaining(["k1"]));
    expect(await memories(together)).not.toContain("m1");
  });

  it("a file nested too deep is counted unreadable and the scrub carries on (review F8)", async () => {
    const root = await archivedRoot();
    // Our own data is never this deep, but a hand-edited file could be: no stack overflow.
    await write(root, `${A}/orchestrator/deep.json`, `${"[".repeat(20_000)}${JSON.stringify({ authorId: KEVIN })}${"]".repeat(20_000)}`);
    const result = await scrubArchive(root, { userId: KEVIN, names: ["Kevin"] });
    expect(result.unreadable).toBeGreaterThanOrEqual(1);
    expect(result.removed).toBeGreaterThan(0);
    // The files after the deep one were still scrubbed.
    expect(((await read(root, `${A}/memories.json`)).memories as Array<{ id: string }>).map((record) => record.id)).toEqual(["m1", "s1"]);
  });
});

describe("the owner's forget-user, step 1 (§7.5)", () => {
  it("drops him from member and participant lists, scrubs the archive and forgets his captured traffic (only his)", async () => {
    const root = await archivedRoot();
    const storage = new StorageService(root);
    recordProviderQuery("assistant", { messages: [{ role: "user", content: "Kevin said hi" }] });
    recordProviderQuery("detector", { messages: [{ role: "user", content: `<@${KEVIN}> is here` }] });
    recordProviderQuery("assistant", { messages: [{ role: "user", content: "Mina runs the bake sale" }] });
    const forgotten: Array<(text: string) => boolean> = [];
    const unsubscribe = onCapturedTrafficForgotten((matches) => forgotten.push(matches));
    const result = await forgetUser(storage, { discordUserId: KEVIN, names: ["Kevin"] });
    unsubscribe();
    expect(result.memberLists).toBe(2);
    expect(result.archive).toMatchObject({ unreadable: 1 });
    expect(((await read(root, `user/servers/${GUILD}/members.json`)).members as Array<{ userId: string }>).map((member) => member.userId)).toEqual([MINA]);
    expect(((await read(root, `user/servers/${GUILD}/active-chat-participants/${CHANNEL}.json`)).participants as Array<{ userId: string }>).map((entry) => entry.userId)).toEqual([MINA]);
    // Review F12: everyone else's Activity stays; the `/api/events` replay is told the same matcher.
    const captured = JSON.stringify(recentQueries());
    expect(captured).not.toContain("Kevin");
    expect(captured).not.toContain(KEVIN);
    expect(captured).toContain("Mina runs the bake sale");
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0]!(`{"content":"<@${KEVIN}>"}`)).toBe(true);
    expect(forgotten[0]!(`{"content":"Mina runs the bake sale"}`)).toBe(false);
    // A dry run changes nothing.
    const dry = await forgetUser(storage, { discordUserId: MINA, dryRun: true });
    expect(dry.archive).toBeUndefined();
    expect(((await read(root, `user/servers/${GUILD}/members.json`)).members as unknown[]).length).toBe(1);
  });
});
