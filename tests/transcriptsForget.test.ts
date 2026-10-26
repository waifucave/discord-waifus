// Forget in the transcripts (Living cast spec §18.5) and D14 for DM transcripts over HTTP (§18.3,
// §18.6): the owner's forget-user removes the person's lines, the lines naming them and their DM
// transcripts (a durable job part that survives a crash), a DM /forget removes the DM transcript at
// or below its floor, removed lines never come back from a REST catch-up, and a DM transcript is
// listed unnamed and opened only with a local includePrivate=1 (never over Remote Access or for the
// dashboard assistant).
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createLocalRequestPrincipal, createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { forgetPersonInHerTranscripts, lineCarriesPerson } from "../src/life/transcripts/forget.js";
import { addTranscriptLine, listTranscriptDays, readTranscriptDay, settleTranscripts, updateTranscriptAccess, type TranscriptLine } from "../src/life/transcripts/store.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { dmFloorAt } from "../src/orchestration/dm/dmStore.js";
import { forgetUser, pendingForgetJobs, resumeForgetJobs } from "../src/orchestration/dm/forgetUser.js";
import { PRIVATE_FILE_NAME } from "../src/shared/schemas/api.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await settleTranscripts();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const KEVIN = "300000000000000003";
const MINA = "300000000000000004";
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const ROOM_KEY = `g_${GUILD}_${CHANNEL}`;
const DM_KEY = `dm_${KEVIN}_ella`;
const TZ = "UTC";
const DISCORD_EPOCH = 1_420_070_400_000n;
const BASE = Date.parse("2026-10-24T12:00:00.000Z");

function line(minute: number, o: Partial<TranscriptLine> & { text: string }): TranscriptLine {
  const at = new Date(BASE + minute * 60_000);
  return { id: ((BigInt(at.getTime()) - DISCORD_EPOCH) << 22n).toString(), at: at.toISOString(), authorId: KEVIN, author: "Kevin", ...o };
}

async function world() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const env = { dataRoot: root, timeZone: TZ };
  await updateTranscriptAccess(root, "ella", () => ({ conversations: { [ROOM_KEY]: [{ from: new Date(BASE - 3_600_000).toISOString() }] } }));
  const lines = {
    kevin: line(1, { text: "I passed my exam" }),
    mention: line(2, { authorId: MINA, author: "Mina", text: "congrats @Kevin!", mentions: [KEVIN] }),
    named: line(3, { authorId: MINA, author: "Mina", text: "Quillon is my hero" }),
    other: line(4, { authorId: MINA, author: "Mina", text: "the oven is ready" }),
    dm: line(5, { text: "a secret only for Ella" })
  };
  for (const entry of [lines.kevin, lines.mention, lines.named, lines.other]) await addTranscriptLine(env, ROOM_KEY, entry);
  await addTranscriptLine(env, DM_KEY, lines.dm);
  return { root, storage, env, lines };
}

const texts = async (root: string, key: string) => (await readTranscriptDay(root, key, "2026-10-24")).map((entry) => entry.text);

describe("the owner's forget-user (§18.5)", () => {
  it("removes their lines, lines that mention or name them, and their DM transcripts; nothing comes back", async () => {
    const w = await world();
    const result = await forgetUser(w.storage, { discordUserId: KEVIN, names: ["Quillon"] }, { now: () => new Date(BASE + 10 * 60_000) });
    expect(result.pending).toBeUndefined();
    // Three room lines here; the DM transcript went with the DM part before (dmForget at the floor).
    expect(result.transcriptLines).toBe(3);
    expect(await texts(w.root, ROOM_KEY)).toEqual(["the oven is ready"]);
    expect(await listTranscriptDays(w.root, DM_KEY)).toEqual([]);
    // A stale REST page (or a gap fill after a restart) never writes them again.
    expect(await addTranscriptLine(w.env, ROOM_KEY, w.lines.kevin)).toBe("skipped");
    expect(await addTranscriptLine(w.env, ROOM_KEY, w.lines.mention)).toBe("skipped");
    expect(await addTranscriptLine(w.env, DM_KEY, w.lines.dm)).toBe("skipped");
    // A new message after the forget is kept.
    expect(await addTranscriptLine(w.env, DM_KEY, line(20, { text: "hi again" }))).toBe("added");
  });

  it("is a durable job part: a crash before it ran is finished at the next start", async () => {
    const w = await world();
    const at = new Date(BASE + 10 * 60_000).toISOString();
    // The job as a crash left it: every part done but the transcripts.
    await mkdir(path.join(w.root, "user", "people"), { recursive: true });
    await writeFile(
      path.join(w.root, "user", "people", "forget-jobs.json"),
      JSON.stringify({ jobs: [{ userId: KEVIN, at, names: ["Quillon"], done: ["record", "floors", "dms", "dm-directory", "member-lists", "archive", "record-copies"] }] })
    );
    expect((await pendingForgetJobs(w.storage))[0]).toMatchObject({ userId: KEVIN });
    expect(await resumeForgetJobs(w.storage)).toBe(1);
    expect(await texts(w.root, ROOM_KEY)).toEqual(["the oven is ready"]);
    expect(await listTranscriptDays(w.root, DM_KEY)).toEqual([]);
    expect(await pendingForgetJobs(w.storage)).toEqual([]);
  });
});

describe("which lines carry the person (§18.5, §7.5 matching)", () => {
  it("a name in the text as a whole word; an author only by the whole name", () => {
    const o = { userId: KEVIN, names: ["Kevin"], at: new Date(BASE + 60 * 60_000) };
    const other = { authorId: "300000000000000099" };
    expect(lineCarriesPerson(line(1, { ...other, author: "Kevin's Mom", text: "dinner is ready" }), o)).toBe(false);
    expect(lineCarriesPerson(line(1, { ...other, author: "Kev", text: "Kevinator wins" }), o)).toBe(false);
    expect(lineCarriesPerson(line(1, { ...other, author: "Mina", text: "ask Kevin" }), o)).toBe(true);
    expect(lineCarriesPerson(line(1, { ...other, author: "kevin", text: "hi" }), o)).toBe(true);
  });
});

describe("a DM user's /forget (§18.5)", () => {
  it("/forget conversation deletes the DM transcript at or below the floor; a catch-up never brings it back", async () => {
    const w = await world();
    await dmForget(w.storage, { userId: KEVIN, waifuId: "ella", scope: "conversation" }, { now: () => new Date(BASE + 10 * 60_000) });
    expect(await listTranscriptDays(w.root, DM_KEY)).toEqual([]);
    expect(await addTranscriptLine(w.env, DM_KEY, w.lines.dm)).toBe("skipped");
    // The rooms are not touched by a conversation forget.
    expect(await texts(w.root, ROOM_KEY)).toHaveLength(4);
  });

  it("/forget everything also removes their lines in the rooms she can see", async () => {
    const w = await world();
    const floor = dmFloorAt(new Date(BASE + 10 * 60_000));
    const result = await forgetPersonInHerTranscripts(w.env, { waifuId: "ella", userId: KEVIN, names: ["Quillon"], at: new Date(BASE + 10 * 60_000), floor });
    expect(result.removedLines).toBe(4);
    expect(await texts(w.root, ROOM_KEY)).toEqual(["the oven is ready"]);
    expect(await listTranscriptDays(w.root, DM_KEY)).toEqual([]);
  });
});

describe("DM transcripts over HTTP (D14)", () => {
  function remote() {
    const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
    return createRemoteRequestPrincipal({ kind: "remote_device", stableId: "remote:travel-mac", deviceId: "travel-mac", peerFingerprint: bytes16(0x21), transportSessionId: bytes16(0x22), trustEpoch: "9" });
  }

  async function api() {
    const w = await world();
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "3.0.0-test",
      port: 3888,
      dataRoot: w.root,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const app = await createApiServer({ dataRoot: w.root, runtime, storage: w.storage, remoteTrust: { isAuthorized: () => true } });
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "ella", name: "Ella", displayName: "Ella" } })).statusCode).toBe(201);
    return { ...w, app };
  }

  it("lists rooms by name and DMs unnamed; a DM transcript opens only with a local includePrivate=1", async () => {
    const w = await api();
    const root = (await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?root=transcripts" })).json();
    expect(root).toMatchObject({ root: "transcripts", dir: "/transcripts", parent: null });
    expect(root.entries.map((entry: { name: string }) => entry.name).sort()).toEqual(["dm", "server-0001"]);
    const room = (await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?dir=/transcripts/server-0001/channel-0002" })).json();
    expect(room.entries).toMatchObject([{ name: "2026-10-24.md", kind: "file", path: "/transcripts/server-0001/channel-0002/2026-10-24.md" }]);
    // A listing gives the stored size (no day is rendered to list a folder).
    expect(room.entries[0].size).toBe((await stat(path.join(w.root, "user", "transcripts", ROOM_KEY, "2026-10-24.jsonl"))).size);
    const day = (await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/transcripts/server-0001/channel-0002/2026-10-24.md" })).json();
    expect(day).toMatchObject({ kind: "text", readOnly: true });
    // The host's time zone renders the clock.
    expect(day.text).toMatch(/\d\d:\d\d Kevin: I passed my exam/u);

    // The DM folder lists people: local reveal only.
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?dir=/transcripts/dm" })).statusCode).toBe(403);
    const revealed = (await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?dir=/transcripts/dm&includePrivate=1" })).json();
    expect(revealed.entries).toMatchObject([{ name: "user-0003", private: true }]);
    const url = "/api/waifus/ella/files/transcripts/dm/user-0003/2026-10-24.md";
    const hidden = await w.app.inject({ method: "GET", url });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.body).not.toContain("secret");
    expect((await w.app.inject({ method: "GET", url: `${url}?includePrivate=1` })).json()).toMatchObject({ private: true, text: expect.stringContaining("a secret only for Ella") });
    const remoteAsk = await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: `${url}?includePrivate=1` });
    expect(remoteAsk.statusCode).toBe(403);
    expect(remoteAsk.json()).toMatchObject({ error: "PrivateContentLocalOnly" });
    const assistantAsk = await dispatchInternal(w.app, createLocalRequestPrincipal(), { conversationId: "c1" }, { method: "GET", url: `${url}?includePrivate=1` });
    expect(assistantAsk.statusCode).toBe(403);
    expect(assistantAsk.body).not.toContain("secret");
    // A DM conversation folder listed from inside dm/ is unnamed without the reveal.
    const remoteRoot = await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: "/api/waifus/ella/files?root=transcripts&includePrivate=1" });
    expect(remoteRoot.statusCode).toBe(403);
    expect(PRIVATE_FILE_NAME).toBe("[private chat redacted]");
  });

  it("refuses writes and deletes", async () => {
    const w = await api();
    const put = await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/transcripts/server-0001/channel-0002/2026-10-24.md", payload: { text: "rewritten" } });
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ error: "ReadOnlyFile" });
    const del = await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/files/transcripts/server-0001/channel-0002/2026-10-24.md" });
    expect(del.statusCode).toBe(400);
    expect(await texts(w.root, ROOM_KEY)).toHaveLength(4);
  });
});
