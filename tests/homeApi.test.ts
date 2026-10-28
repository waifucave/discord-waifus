// Her own computer over HTTP (Living cast spec §16.11): listing her folders, reading a file as JSON
// or raw bytes, writing under her Write tool's checks (places.md refused, broken JSON refused with
// line and column, revision by content hash), deleting, and her reminders and watches with delete.
// A file from a private chat is named and opened only with a local includePrivate=1 (D14): over
// Remote Access and for the dashboard assistant it stays redacted. Temp data roots, Discord offline.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createLocalRequestPrincipal, createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { HomeStore, homeLimitsOf, sha256 } from "../src/life/home/homeStore.js";
import { localMinuteText } from "../src/life/home/specialFiles.js";
import { lifePaths } from "../src/life/paths.js";
import { hostTimeZone } from "../src/orchestration/context/timeFormat.js";
import {
  HerFileDeleteResponseSchema,
  HerFileResponseSchema,
  HerFilesListResponseSchema,
  HerFileWriteResponseSchema,
  PlanEntryDeleteResponseSchema,
  PRIVATE_FILE_NAME,
  WakeupsResponseSchema
} from "../src/shared/schemas/api.js";
import { AppConfigSchema } from "../src/shared/schemas/config.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const KEVIN = "300000000000000003";
const DM_KEY = `dm_${KEVIN}_ella`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

function remote() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x21),
    transportSessionId: bytes16(0x22),
    trustEpoch: "9"
  });
}

async function world() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "3.0.0-test",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({ dataRoot: root, runtime, storage, remoteTrust: { isAuthorized: () => true } });
  apps.push(app);
  expect((await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "ella", name: "Ella", displayName: "Ella" } })).statusCode).toBe(201);
  const home = new HomeStore(storage, "ella", "ella", () => homeLimitsOf(AppConfigSchema.parse({}).life));
  return { root, storage, app, home };
}

/** A DM download in /tmp/dm/kevin and a copy of it in her home (same bytes: private by hash). */
async function dmFiles(w: Awaited<ReturnType<typeof world>>) {
  const menu = Buffer.from("Kevin's secret menu: brownies\n");
  const saved = await w.home.saveDownload(w.home.path("tmp", ["dm", "kevin", "a7-menu.txt"]), menu, {
    placeKey: DM_KEY,
    messageId: "1",
    authorId: KEVIN,
    attachmentId: "9",
    downloadedAt: new Date().toISOString()
  });
  expect(saved).toBe(true);
  await w.home.files.writeBytes(w.home.path("home", ["kept-menu.txt"]), menu);
}

// Each test builds a whole API server on a temp root (about 1–2 s alone, several times that while
// the suite's WebAssembly-heavy Bash tests run in other workers): a longer timeout than the default.
describe("her files", { timeout: 30_000 }, () => {
  it("lists folders first, reads text as JSON and images as raw bytes, never naming a DM file without a local reveal", async () => {
    const w = await world();
    const put = await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/home/ella/people/kevin.md", payload: { text: "# Kevin\nlikes lemon cake\n" } });
    expect(put.statusCode).toBe(200);
    const written = HerFileWriteResponseSchema.parse(put.json());
    expect(written).toMatchObject({ path: "/home/ella/people/kevin.md", display: "~/people/kevin.md", created: true, hash: sha256("# Kevin\nlikes lemon cake\n") });
    await w.home.files.writeBytes(w.home.path("home", ["cake.png"]), PNG);
    await dmFiles(w);

    const list = HerFilesListResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files" })).json());
    expect(list).toMatchObject({ root: "home", dir: "/home/ella", display: "~", parent: null, includePrivate: false, redacted: 1 });
    // life/profile.json is written from her config when she is created (spec §17.1, §21).
    expect(list.entries.map((entry) => entry.name)).toEqual(["life", "people", "cake.png", PRIVATE_FILE_NAME]);
    expect(list.entries[3]).toMatchObject({ kind: "file", private: true, redacted: true });
    expect(list.entries[3]!.path).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("kept-menu");
    expect(list.usage.maxFiles).toBeGreaterThan(0);

    const tmp = HerFilesListResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?root=tmp&dir=dm" })).json());
    expect(tmp.entries).toEqual([expect.objectContaining({ name: PRIVATE_FILE_NAME, kind: "dir", private: true, redacted: true })]);
    expect(JSON.stringify(tmp)).not.toContain("kevin");
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?root=tmp&dir=dm/kevin" })).json()).toMatchObject({ error: "PrivateContentLocalOnly" });
    const revealed = HerFilesListResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files?root=tmp&dir=dm/kevin&includePrivate=1" })).json());
    expect(revealed.entries).toEqual([expect.objectContaining({ name: "a7-menu.txt", path: "/tmp/dm/kevin/a7-menu.txt", private: true })]);

    const note = HerFileResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/~/people/kevin.md" })).json());
    expect(note).toMatchObject({ kind: "text", text: "# Kevin\nlikes lemon cake\n", hash: written.hash });
    const image = HerFileResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/home/ella/cake.png" })).json());
    expect(image).toMatchObject({ kind: "image", contentType: "image/png" });
    expect(image.text).toBeUndefined();
    const raw = await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/home/ella/cake.png?raw=1" });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("image/png");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.rawPayload.equals(PNG)).toBe(true);

    // A DM file (by folder or by hash): 403 without the reveal, and always over Remote Access.
    for (const url of ["/api/waifus/ella/files/tmp/dm/kevin/a7-menu.txt", "/api/waifus/ella/files/home/ella/kept-menu.txt"]) {
      const hidden = await w.app.inject({ method: "GET", url });
      expect(hidden.statusCode).toBe(403);
      expect(hidden.body).not.toContain("brownies");
      expect((await w.app.inject({ method: "GET", url: `${url}?includePrivate=1` })).json()).toMatchObject({ private: true, text: "Kevin's secret menu: brownies\n" });
      const remoteAsk = await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: `${url}?includePrivate=1` });
      expect(remoteAsk.statusCode).toBe(403);
      expect(remoteAsk.json()).toMatchObject({ error: "PrivateContentLocalOnly" });
      const assistantAsk = await dispatchInternal(w.app, createLocalRequestPrincipal(), { conversationId: "c1" }, { method: "GET", url: `${url}?includePrivate=1` });
      expect(assistantAsk.statusCode).toBe(403);
    }
    const remoteList = await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: "/api/waifus/ella/files" });
    expect(remoteList.statusCode).toBe(200);
    expect(remoteList.body).not.toContain("kept-menu");
    // Paths outside her folders are refused.
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/etc/passwd" })).statusCode).toBe(400);
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/home/ella/../../etc/passwd" })).statusCode).toBe(400);
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/nobody/files" })).statusCode).toBe(404);
  });

  it("writes under her Write tool's checks: places.md refused, broken JSON refused with line and column, hash revisions", async () => {
    const w = await world();
    const places = await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/home/ella/life/places.md", payload: { text: "mine now" } });
    expect(places.statusCode).toBe(400);
    expect(places.json()).toMatchObject({ error: "ReadOnlyFile", message: expect.stringContaining("places.md") });

    const broken = await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/life/wakeups.json", payload: { text: '[\n  {"kind": "at", "when": "2026-10-25 18:00", "note": "x"}\n  {"note": "y"}\n]' } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: "InvalidFile", message: expect.stringMatching(/^wakeups\.json line 3, column 3: /u) });
    expect(broken.body).not.toContain(w.root);
    expect((await w.home.files.inspect(w.home.life("wakeups.json"))).kind).toBe("missing");

    const first = HerFileWriteResponseSchema.parse((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/plans.md", payload: { text: "bake", expectedHash: null } })).json());
    expect((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/plans.md", payload: { text: "again", expectedHash: null } })).statusCode).toBe(409);
    const stale = await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/plans.md", payload: { text: "x", expectedHash: sha256("not it") } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "Conflict" });
    const second = HerFileWriteResponseSchema.parse((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/plans.md", payload: { text: "bake more", expectedHash: first.hash } })).json());
    expect(second.created).toBe(false);
    expect((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/big.md", payload: { text: "x".repeat(300 * 1024) } })).statusCode).toBe(413);

    // A new wakeup gets its id when saved (the file is rewritten).
    const at = localMinuteText(new Date(Date.now() + 2 * 3_600_000), hostTimeZone());
    const saved = HerFileWriteResponseSchema.parse((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/life/wakeups.json", payload: { text: JSON.stringify([{ kind: "at", when: at, note: "flyer" }]) } })).json());
    expect(saved.rewritten).toBe(true);

    expect((await w.app.inject({ method: "DELETE", url: `/api/waifus/ella/files/~/plans.md?expectedHash=${first.hash}` })).statusCode).toBe(409);
    const deleted = await w.app.inject({ method: "DELETE", url: `/api/waifus/ella/files/~/plans.md?expectedHash=${second.hash}` });
    expect(HerFileDeleteResponseSchema.parse(deleted.json())).toEqual({ waifuId: "ella", deleted: true });
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/files/~/plans.md" })).statusCode).toBe(404);
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/files/~/life/places.md" })).statusCode).toBe(400);

    // DM files are written or deleted only with the local reveal; the assistant needs its card.
    await dmFiles(w);
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/files/~/kept-menu.txt" })).statusCode).toBe(403);
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/files/~/kept-menu.txt?includePrivate=1" })).statusCode).toBe(200);
    const unconfirmed = await dispatchInternal(w.app, createLocalRequestPrincipal(), { conversationId: "c1" }, { method: "PUT", url: "/api/waifus/ella/files/~/a.md", payload: { text: "hi" } });
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json()).toMatchObject({ error: "AssistantConfirmationRequired" });
  });
});

describe("her wakeups (§30.3)", { timeout: 30_000 }, () => {
  it("lists them with their sources, redacts a wakeup watching a DM, and deletes one entry by rewriting the file", async () => {
    const w = await world();
    const zone = hostTimeZone();
    const soon = localMinuteText(new Date(Date.now() + 2 * 3_600_000), zone);
    const later = localMinuteText(new Date(Date.now() + 5 * 3_600_000), zone);
    const filter = "(msg, state) => { state.seen = (state.seen || 0) + 1; return msg.text.includes('exam'); }";
    await w.home.files.writeBytes(
      w.home.life("wakeups.json"),
      Buffer.from(
        JSON.stringify([
          { id: "t1", kind: "at", when: soon, note: "flyer" },
          { id: "t2", kind: "every", when: "day 08:30", note: "water plants" },
          { id: "w1", kind: "watch", places: "everywhere", filter: [], options: { until: soon }, note: "tea" },
          { id: "w2", kind: "watch", places: "dm/kevin", filter, options: { until: later }, note: "Kevin's exam result", state: { seen: 2 } },
          { id: "w3", kind: "watch", places: "everywhere", filter: { words: ["cake"] }, options: { until: later }, note: "cake talk", state: { last: "a DM's words" } }
        ])
      )
    );
    await mkdir(path.dirname(w.storage.dataPath(lifePaths.wakeupIds("ella"))), { recursive: true });
    await writeFile(w.storage.dataPath(lifePaths.wakeupIds("ella")), JSON.stringify({ nextId: { t: 3, w: 4, p: 1 }, watches: { w2: { placeKeys: [DM_KEY], fires: [] } } }));

    const listed = WakeupsResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/wakeups" })).json());
    expect(listed.entries.map((entry) => entry.id)).toEqual(["t1", "t2", "w1", "w2", "w3"]);
    expect(listed.unreadable).toBeUndefined();
    expect(listed.entries[1]!.next).toHaveLength(3);
    expect(listed.entries[2]).toMatchObject({ id: "w1", note: "tea", places: "everywhere", filter: [] });
    // The private one: only that it is private. An everywhere watch's state may hold a DM's words.
    expect(listed.entries[3]).toMatchObject({ id: "w2", private: true, note: PRIVATE_FILE_NAME, places: PRIVATE_FILE_NAME, filter: PRIVATE_FILE_NAME, state: PRIVATE_FILE_NAME });
    expect(listed.entries[4]).toMatchObject({ id: "w3", note: "cake talk", filter: { words: ["cake"] }, state: PRIVATE_FILE_NAME });
    expect(JSON.stringify(listed)).not.toContain("exam");
    expect(JSON.stringify(listed)).not.toContain("a DM's words");
    const open = WakeupsResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/wakeups?includePrivate=1" })).json());
    // With the local reveal, her code itself (the source).
    expect(open.entries[3]).toMatchObject({ note: "Kevin's exam result", places: "dm/kevin", filter, state: { seen: 2 } });
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: "/api/waifus/ella/wakeups?includePrivate=1" })).statusCode).toBe(403);

    expect(PlanEntryDeleteResponseSchema.parse((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/wakeups/t1" })).json())).toEqual({ waifuId: "ella", removed: "t1" });
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/wakeups/t1" })).statusCode).toBe(404);
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/wakeups/w2" })).json()).toEqual({ waifuId: "ella", removed: "w2" });
    const after = await w.home.readWakeups();
    expect(after.entries.map((entry) => entry.id)).toEqual(["t2", "w1", "w3"]);
    expect((await w.home.readWakeupSide()).watches["w2"]).toBeUndefined();
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/wakeups/w9" })).statusCode).toBe(404);

    // A hand-broken file: listed as unreadable, and nothing is rewritten.
    await w.home.files.writeBytes(w.home.life("wakeups.json"), Buffer.from(`[{"id": "t2", "kind": "at", "when": "${later}", "note": "x"},]`));
    expect((await w.app.inject({ method: "GET", url: "/api/waifus/ella/wakeups" })).json()).toMatchObject({ unreadable: true });
    expect((await w.app.inject({ method: "DELETE", url: "/api/waifus/ella/wakeups/t2" })).statusCode).toBe(409);
  });
});

describe("D14 by any spelling (review S3, S4)", { timeout: 30_000 }, () => {
  it("a DM folder spelled /tmp/DM or /tmp/Dm is private like /tmp/dm, for listing and reading", async () => {
    const w = await world();
    await dmFiles(w);
    await w.home.files.writeBytes(w.home.path("tmp", ["dm", "kevin", "summary.txt"]), Buffer.from("Kevin is moving to Oslo\n"));
    const over = (url: string) => dispatchInternal(w.app, remote(), undefined, { method: "GET", url });
    const listed = HerFilesListResponseSchema.parse((await over("/api/waifus/ella/files?root=tmp&dir=DM")).json());
    expect(listed.dir).toBe("/tmp/dm");
    expect(listed.entries.every((entry) => entry.redacted === true)).toBe(true);
    for (const url of ["/api/waifus/ella/files?root=tmp&dir=DM/kevin", "/api/waifus/ella/files?root=tmp&dir=dm/KEVIN"]) {
      expect((await over(url)).statusCode, url).toBe(403);
    }
    for (const url of ["/api/waifus/ella/files/tmp/DM/kevin/summary.txt", "/api/waifus/ella/files/tmp/Dm/Kevin/a7-menu.txt", "/api/waifus/ella/files/tmp/dm/kevin/SUMMARY.TXT?raw=1"]) {
      const answer = await over(url);
      expect(answer.statusCode, url).toBe(403);
      expect(answer.body).not.toContain("Oslo");
    }
  });

  it("wakeups.json with a wakeup watching a DM reads redacted without includePrivate (also for the assistant), and can't be replaced or deleted then", async () => {
    const w = await world();
    const later = localMinuteText(new Date(Date.now() + 3 * 86_400_000), hostTimeZone());
    const raw = `[\n  {"id": "w1", "kind": "watch", "places": "dm/kevin", "filter": {"words": ["biopsy"]}, "options": {"until": "${later}"}, "note": "ask Kevin how the biopsy went"},\n  {"id": "w2", "kind": "watch", "places": "everywhere", "filter": [], "options": {"until": "${later}"}, "note": "tea"}\n]\n`;
    await w.home.files.writeBytes(w.home.life("wakeups.json"), Buffer.from(raw));
    for (const principal of [remote(), createLocalRequestPrincipal()]) {
      const delegation = principal.kind === "local" ? { conversationId: "c1" } : undefined;
      for (const url of ["/api/waifus/ella/files/~/life/wakeups.json", "/api/waifus/ella/files/home/ella/Life/WAKEUPS.json"]) {
        const answer = await dispatchInternal(w.app, principal, delegation, { method: "GET", url });
        expect(answer.statusCode, url).toBe(200);
        expect(answer.body).not.toContain("biopsy");
        const file = HerFileResponseSchema.parse(answer.json());
        expect(file).toMatchObject({ redacted: true, readOnly: true, private: true, special: "wakeups" });
        expect(file.text).toContain(`"note": "${PRIVATE_FILE_NAME}"`);
        expect(file.text).toContain('"note": "tea"');
      }
      const rawBytes = await dispatchInternal(w.app, principal, delegation, { method: "GET", url: "/api/waifus/ella/files/~/life/wakeups.json?raw=1" });
      expect(rawBytes.body).not.toContain("biopsy");
    }
    // Writing the redacted copy back (or deleting the file) would lose the private wakeup: refused.
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "PUT", url: "/api/waifus/ella/files/~/life/wakeups.json", headers: { "idempotency-key": Buffer.alloc(32, 0x61).toString("base64url") }, payload: { text: "[]\n", expectedHash: sha256(raw) } })).statusCode).toBe(403);
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "DELETE", url: `/api/waifus/ella/files/~/life/wakeups.json?expectedHash=${sha256(raw)}`, headers: { "idempotency-key": Buffer.alloc(32, 0x62).toString("base64url") } })).statusCode).toBe(403);
    // Locally with the reveal, the whole file.
    const local = HerFileResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/~/life/wakeups.json?includePrivate=1" })).json());
    expect(local.text).toBe(raw);
    expect(local.redacted).toBeUndefined();
    // A file that does not read whole and names a DM is refused outright.
    await w.home.files.writeBytes(w.home.life("wakeups.json"), Buffer.from(`[{"id": "w1", "kind": "watch", "places": "dm/kevin", "options": {"until": "${later}"}, "note": "biopsy"},]`));
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: "/api/waifus/ella/files/~/life/wakeups.json" })).statusCode).toBe(403);
  });

  it("a notes file reads without its lines from private chats unless a local reveal (also for the assistant), read-only, with the real file's hash", async () => {
    const w = await world();
    await dmFiles(w);
    const memory = "# Memory\n- [Kevin](people/kevin.md) — likes lemon cake\n- [Menu](kept-menu.txt) — the brownies he sent\n- talked in dm/kevin about Oslo\n";
    await w.home.files.writeBytes(w.home.home("MEMORY.md"), Buffer.from(memory));
    await w.home.files.writeBytes(w.home.path("home", ["people", "kevin.md"]), Buffer.from("# Kevin\n- likes lemon cake\n"));
    const delegation = { conversationId: "c1" };
    for (const [principal, via] of [[remote(), undefined], [createLocalRequestPrincipal(), delegation], [createLocalRequestPrincipal(), undefined]] as const) {
      const answer = await dispatchInternal(w.app, principal, via, { method: "GET", url: "/api/waifus/ella/files/~/MEMORY.md" });
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain("brownies");
      expect(answer.body).not.toContain("Oslo");
      const file = HerFileResponseSchema.parse(answer.json());
      expect(file).toMatchObject({ redacted: true, readOnly: true, private: true });
      expect(file.text).toBe(`# Memory\n- [Kevin](people/kevin.md) — likes lemon cake\n- ${PRIVATE_FILE_NAME}\n- ${PRIVATE_FILE_NAME}\n`);
      // The revision is the file on disk, not the copy shown.
      expect(file.hash).toBe(sha256(memory));
      const rawBytes = await dispatchInternal(w.app, principal, via, { method: "GET", url: "/api/waifus/ella/files/~/MEMORY.md?raw=1" });
      expect(rawBytes.body).not.toContain("Oslo");
    }
    // A note with nothing private reads as it is.
    const plainNote = HerFileResponseSchema.parse((await dispatchInternal(w.app, remote(), undefined, { method: "GET", url: "/api/waifus/ella/files/~/people/kevin.md" })).json());
    expect(plainNote.redacted).toBeUndefined();
    expect(plainNote.readOnly).toBeUndefined();
    // Writing the redacted copy back, or deleting the file, would lose her private lines: refused.
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "PUT", url: "/api/waifus/ella/files/~/MEMORY.md", headers: { "idempotency-key": Buffer.alloc(32, 0x63).toString("base64url") }, payload: { text: "# Memory\n", expectedHash: sha256(memory) } })).statusCode).toBe(403);
    expect((await dispatchInternal(w.app, remote(), undefined, { method: "DELETE", url: `/api/waifus/ella/files/~/MEMORY.md?expectedHash=${sha256(memory)}`, headers: { "idempotency-key": Buffer.alloc(32, 0x64).toString("base64url") } })).statusCode).toBe(403);
    // Locally with the reveal: the whole file, editable with the same hash.
    const local = HerFileResponseSchema.parse((await w.app.inject({ method: "GET", url: "/api/waifus/ella/files/~/MEMORY.md?includePrivate=1" })).json());
    expect(local.text).toBe(memory);
    expect(local.redacted).toBeUndefined();
    expect(local.hash).toBe(sha256(memory));
    expect((await w.app.inject({ method: "PUT", url: "/api/waifus/ella/files/~/MEMORY.md?includePrivate=1", payload: { text: "# Memory\n", expectedHash: local.hash } })).statusCode).toBe(200);
  });
});
