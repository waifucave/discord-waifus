// DM deletion scopes (spec 9.1.4), the DM /forget command (9.1.5, O3) and the /api/dms routes
// (9.8): manifest, id validation, listing without message bodies, forget with audit.

import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { DiscordImageFetcher } from "../src/discord/attachments.js";
import { readConversationImageKeys } from "../src/discord/imageIndex.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { OCR_RESULTS_DIR, ocrCacheKey } from "../src/orchestration/ocr.js";
import {
  ForgetRecordCorruptError,
  pendingScrubsPath,
  queuePendingScrub,
  readForgottenPeople,
  readPendingScrubs,
  recordForgottenPerson
} from "../src/orchestration/dm/forgotten.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { readDmLimit, readDmState, updateDmLimit, updateDmState } from "../src/orchestration/dm/dmStore.js";
import { forgetUser, pendingForgetJobs, resumeForgetJobs } from "../src/orchestration/dm/forgetUser.js";
import { homeOf } from "./lifeFixtures.js";
import { AuditStore } from "../src/storage/auditStore.js";
import type { StorageService } from "../src/storage/storageService.js";
import { DmDiscord, USER, dmRoot, dmRuntime, seedDmWorld } from "./dmFixtures.js";
import { removeTempRoot } from "./testUtils.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const KEY = conversationKey({ kind: "dm", waifuId: "aria", userId: USER });
const exists = (file: string) => access(file).then(() => true, () => false);

/** One answered DM: the conversation directory, the DM state and one rate-limit stamp, written directly. */
async function world() {
  const { root, storage } = await dmRoot(roots);
  await seedDmWorld(storage);
  const discord = new DmDiscord();
  const runtime = dmRuntime(storage, discord);
  const now = new Date().toISOString();
  await updateDmState(storage, { userId: USER, waifuId: "aria", botId: "aria-bot" }, (current) => ({
    ...current,
    userDisplayName: "Kevin",
    lastInboundMessageId: "1300000000000000001",
    lastInboundAt: now,
    lastRepliedMessageId: "1300000000000000002",
    lastReplyAt: now
  }));
  await updateDmLimit(storage, USER, "aria", (current) => ({ ...current, replyTimestamps: [now] }));
  const dir = path.join(root, "user", "conversations", KEY);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "refs.json"), JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: now, counter: 361, refs: { "1300000000000000001": "a0" } }));
  return { root, storage, discord, runtime };
}

describe("dmForget scopes", () => {
  it("conversation: deletes the transcript, keeps state and the limiter", async () => {
    const { root, storage, runtime } = await world();
    const dry = await dmForget(storage, { userId: USER, waifuId: "aria", scope: "conversation", dryRun: true });
    expect(dry.deleted).toMatchObject({ dmContexts: 1, dmStates: 0 });
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(true);

    const done = await runtime.forgetDm({ userId: USER, waifuId: "aria", scope: "conversation" });
    expect(done.deleted).toMatchObject({ dmContexts: 1 });
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.lastInboundMessageId).toBeDefined();
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("all: also deletes the state and cached images; the limiter stays", async () => {
    const { root, storage, runtime } = await world();
    const purged: string[][] = [];
    const done = await dmForget(
      storage,
      { userId: USER, waifuId: "aria", scope: "all" },
      { purgeImages: async (keys) => void purged.push(keys), imageKeys: () => ["att:1"] }
    );
    expect(done.deleted).toMatchObject({ dmContexts: 1, dmStates: 1 });
    expect(purged).toEqual([["att:1"]]);
    expect(await exists(path.join(root, "user", "dms", USER, "aria.json"))).toBe(false);
    expect(await exists(path.join(root, "user", "dms", USER, "limits", "aria.json"))).toBe(true);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("the owner's forget-user removes every DM file of the user, counters included (the floor stays)", async () => {
    const { root, storage, runtime } = await world();
    const dry = await forgetUser(storage, { discordUserId: USER, dryRun: true });
    expect(dry).toMatchObject({ dmContexts: 1, dmStates: 1, dmLimits: 1 });
    expect(await readDmState(storage, USER, "aria")).toBeDefined();
    const done = await runtime.forgetUser({ discordUserId: USER });
    expect(done).toMatchObject({ discordUserId: USER, dryRun: false, dmContexts: 1, dmStates: 1, dmLimits: 1 });
    // Counters and state are gone; only the forget floor is written back.
    expect(await exists(path.join(root, "user", "dms", USER, "aria.json"))).toBe(false);
    const limits = await readDmLimit(storage, USER, "aria");
    expect(limits.replyTimestamps).toEqual([]);
    expect(limits.floorMessageId).toBeDefined();
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    await runtime.stop();
  });

  it("the DM /forget command forgets for that waifu and user only and never resets the limiter", async () => {
    const { root, storage, runtime } = await world();
    expect(await runtime.handleDmForgetCommand({ waifuId: "aria", botId: "aria-bot", userId: USER, scope: "conversation" })).toBe("Done: I deleted our private chat.");
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    expect(await readDmState(storage, USER, "aria")).toBeDefined();
    expect(await readPendingScrubs(storage, "aria")).toEqual([]);
    expect(await runtime.handleDmForgetCommand({ waifuId: "aria", botId: "aria-bot", userId: USER, scope: "everything" })).toMatch(/marked to be forgotten/);
    expect(await readDmState(storage, USER, "aria")).toBeUndefined();
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    // She has no life or notes yet, so there is nothing to scrub and nothing is queued (the life
    // scrub and its 6-hour rate limit are covered in tests/lifeForget.test.ts).
    await runtime.settleBackground();
    expect(await readPendingScrubs(storage, "aria")).toEqual([]);
    expect(await readForgottenPeople(storage)).toEqual([]);
    await runtime.stop();
  });

  it("the owner's forget-user records the person in user/people/forgotten.json (a dry run does not)", async () => {
    const { root, storage, runtime } = await world();
    await forgetUser(storage, { discordUserId: USER, dryRun: true });
    expect(await readForgottenPeople(storage)).toEqual([]);
    await runtime.forgetUser({ discordUserId: USER });
    const first = await readForgottenPeople(storage);
    expect(first).toEqual([{ userId: USER, at: expect.any(String) }]);
    expect(JSON.parse(await readFile(path.join(root, "user", "people", "forgotten.json"), "utf8"))).toEqual({ forgotten: first });
    // A second forget keeps one entry per person and moves `at` forward.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await forgetUser(storage, { discordUserId: USER });
    const second = await readForgottenPeople(storage);
    expect(second).toHaveLength(1);
    expect(second[0]!.at > first[0]!.at).toBe(true);
    await runtime.stop();
  });
});

describe("forget record files", () => {
  it("only a missing file reads as empty; an unreadable one keeps a copy and carries over what can still be read", async () => {
    const { root, storage } = await dmRoot(roots);
    expect(await readForgottenPeople(storage)).toEqual([]);

    const file = path.join(root, "user", "people", "forgotten.json");
    await mkdir(path.dirname(file), { recursive: true });
    const torn = '{"forgotten": [{"userId": "300000000000000777", "at": "2026-10-01T00:00:00.000Z"}, {"userId": "300000000000000778"';
    await writeFile(file, torn);
    // A read never pretends nobody was forgotten.
    await expect(readForgottenPeople(storage)).rejects.toBeInstanceOf(ForgetRecordCorruptError);

    const warn = vi.fn();
    const at = new Date("2026-10-24T12:00:00.000Z");
    await recordForgottenPerson(storage, USER, at, { logger: { warn } });
    // Whole entries keep their time; a bare id is forgotten as of now; the new one is added.
    expect(await readForgottenPeople(storage)).toEqual([
      { userId: "300000000000000777", at: "2026-10-01T00:00:00.000Z" },
      { userId: "300000000000000778", at: at.toISOString() },
      { userId: USER, at: at.toISOString() }
    ]);
    const aside = (await readdir(path.dirname(file))).filter((name) => name.startsWith("forgotten.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file), aside[0]!), "utf8")).toBe(torn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a copy was kept"), expect.objectContaining({ file, movedTo: path.join(path.dirname(file), aside[0]!), salvaged: 2 }));

    // A torn pending-scrubs file never loses a queued scrub: reads salvage it, an unknown source runs as the owner's.
    const scrubs = pendingScrubsPath(root, "aria");
    await mkdir(path.dirname(scrubs), { recursive: true });
    await writeFile(scrubs, '{"scrubs": [{"userId": "300000000000000779", "at": "2026-10-20T00:00:00.000Z", "source": "dm_forget_everything", "names": ["Zed"]}, {"userId": "300000000000000780"');
    const salvaged = await readPendingScrubs(storage, "aria", { logger: { warn } });
    expect(salvaged[0]).toEqual({ userId: "300000000000000779", at: "2026-10-20T00:00:00.000Z", source: "dm_forget_everything", names: ["Zed"] });
    expect(salvaged[1]).toMatchObject({ userId: "300000000000000780", source: "owner_forget" });
    await queuePendingScrub(storage, "aria", USER, at, { logger: { warn } });
    expect((await readPendingScrubs(storage, "aria")).map((scrub) => [scrub.userId, scrub.source])).toEqual([
      ["300000000000000779", "dm_forget_everything"],
      ["300000000000000780", "owner_forget"],
      [USER, "dm_forget_everything"]
    ]);
    // The wrong shape salvages nothing, and is still never an error for a queued scrub.
    await writeFile(scrubs, JSON.stringify({ scrubs: "nope" }));
    expect(await readPendingScrubs(storage, "aria", { logger: { warn } })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("a later forget never weakens a queued scrub's source and keeps every name", async () => {
    const { storage } = await dmRoot(roots);
    const at = new Date("2026-10-24T12:00:00.000Z");
    await queuePendingScrub(storage, "aria", USER, at, { source: "owner_forget", names: ["Kevin"] });
    await queuePendingScrub(storage, "aria", USER, new Date(at.getTime() + 1_000), { source: "dm_forget_conversation", names: ["kevbaker"], sharedNames: ["Sam"] });
    expect(await readPendingScrubs(storage, "aria")).toEqual([
      { userId: USER, at: new Date(at.getTime() + 1_000).toISOString(), source: "owner_forget", names: ["Kevin", "kevbaker"], sharedNames: ["Sam"] }
    ]);
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("forget purges cached images and OCR without the runtime (review I5)", () => {
  it("reads the durable image index and a legacy ledger; counts bytes and OCR text exactly", async () => {
    const { root, storage } = await world();
    // An image cached for the DM (the fetcher records it in the conversation's index).
    const fetcher = new DiscordImageFetcher({
      dataRoot: root,
      fetch: (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch
    });
    const fetched = await fetcher.get(
      { key: "att:1300000000000000011", url: "https://cdn.discordapp.com/attachments/7/1300000000000000011/a.png", conversationKey: KEY },
      { purpose: "inline" }
    );
    expect(fetched.ok).toBe(true);
    expect(await readConversationImageKeys(root, KEY)).toEqual(["att:1300000000000000011"]);
    // An image an older version kept in the conversation ledger, with only its OCR text cached.
    await writeFile(
      path.join(root, "user", "conversations", KEY, "ledger.json"),
      JSON.stringify({ entries: { a: { id: "1300000000000000012", images: [{ key: "att:1300000000000000012", url: "https://cdn.discordapp.com/x.png" }] } } })
    );
    const ocrFile = path.join(root, "app", "cache", "ocr", OCR_RESULTS_DIR, `${ocrCacheKey("att:1300000000000000012")}.json`);
    await mkdir(path.dirname(ocrFile), { recursive: true });
    await writeFile(ocrFile, JSON.stringify({ schemaVersion: 2, text: "menu", engine: "bundled-tesseract", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const imageFiles = path.join(root, "app", "cache", "images");
    expect((await readdir(imageFiles)).length).toBeGreaterThan(0);

    // The API path with no runtime behind it.
    const { app } = await api(storage, root);
    const dry = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true, dryRun: true } });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, cachedImages: 2 });
    expect(await exists(ocrFile)).toBe(true);

    const done = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true } });
    expect(done.json()).toMatchObject({ dryRun: false, cachedImages: 2, dmContexts: 1 });
    expect(await exists(ocrFile)).toBe(false);
    expect((await readdir(imageFiles)).filter((name) => name.endsWith(".bin"))).toEqual([]);
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
  });
});

async function api(storage: StorageService, root: string, castRuntime?: ReturnType<typeof dmRuntime>) {
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const auditStore = new AuditStore(root, { storage });
  const app = await createApiServer({ dataRoot: root, runtime, storage, administration: { auditStore }, ...(castRuntime ? { castRuntime } : {}) });
  apps.push(app);
  return { app, auditStore };
}

describe("/api/dms", () => {
  it("is in the route policy manifest with the spec policies", () => {
    const find = (method: string, route: string) => ROUTE_POLICY_MANIFEST.find((entry) => entry.method === method && entry.path === route);
    expect(find("GET", "/api/dms")).toBeDefined();
    expect(find("GET", "/api/dms/:waifuId/:userId")).toBeDefined();
    expect(find("POST", "/api/dms/:waifuId/:userId/forget")).toMatchObject({ auditAction: "dm.forget", retryClass: "transactional" });
  });

  it("lists and shows DMs without message bodies, validates ids, and forgets with an audit record", async () => {
    const { root, storage, runtime } = await world();
    await runtime.stop();
    const { app, auditStore } = await api(storage, root);

    const list = await app.inject({ method: "GET", url: "/api/dms" });
    expect(list.statusCode, list.body).toBe(200);
    const [conversation] = list.json().conversations;
    expect(conversation).toMatchObject({
      conversationKey: KEY,
      waifuId: "aria",
      userId: USER,
      userDisplayName: "Kevin",
      rateLimit: { used: 1, max: 30, windowMinutes: 60, limited: false }
    });
    expect(list.body).not.toContain("\"hi\"");
    expect((await app.inject({ method: "GET", url: "/api/dms?waifuId=mina" })).json().conversations).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/dms?limit=500" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dms?userId=kevin" })).statusCode).toBe(400);

    const show = await app.inject({ method: "GET", url: `/api/dms/aria/${USER}` });
    expect(show.json()).toMatchObject({ state: { waifuId: "aria", userId: USER }, rateLimit: { used: 1 } });
    expect((await app.inject({ method: "GET", url: `/api/dms/mina/${USER}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/dms/bad%24id/${USER}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/dms/.../${USER}/forget`, payload: { confirm: true, scope: "all" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dms/aria/not-a-snowflake" })).statusCode).toBe(400);

    const noConfirm = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { scope: "all" } });
    expect(noConfirm.statusCode).toBe(400);
    const dry = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { confirm: true, scope: "all", dryRun: true } });
    expect(dry.json()).toMatchObject({ dryRun: true, scope: "all", deleted: { dmContexts: 1, dmStates: 1 } });
    await homeOf({ root: storage.dataRoot }, "aria").write("MEMORY.md", "# Memory\n");
    const done = await app.inject({ method: "POST", url: `/api/dms/aria/${USER}/forget`, payload: { confirm: true, scope: "all" } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ dryRun: false, deleted: { dmStates: 1 } });
    expect(await readDmState(storage, USER, "aria")).toBeUndefined();
    // No cast runtime: her life scrub is queued (with his name) for her next start.
    expect(await readPendingScrubs(storage, "aria")).toMatchObject([{ userId: USER, source: "owner_forget", names: ["Kevin"] }]);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    expect((await auditStore.list()).some((record) => record.action === "dm.forget")).toBe(true);
  });

  it("reports discord.dm in /api/runtime without a live runtime (nothing has the intent)", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const { app } = await api(storage, root);
    const response = await app.inject({ method: "GET", url: "/api/runtime" });
    expect(response.json().discord.dm).toEqual({ eligibleWaifus: [{ waifuId: "aria", botId: "aria-bot", intentActive: false }], warnings: [] });
  });
});

describe("POST /api/people/:userId/forget (Living cast §14.1, DM part)", () => {
  it("is in the route policy manifest and needs confirm; dry runs count, the real run deletes and audits", async () => {
    expect(ROUTE_POLICY_MANIFEST.find((entry) => entry.method === "POST" && entry.path === "/api/people/:userId/forget")).toMatchObject({
      auditAction: "people.forget",
      retryClass: "transactional"
    });
    const { root, storage, runtime } = await world();
    await runtime.stop();
    const { app, auditStore } = await api(storage, root);
    expect((await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/people/kevin/forget", payload: { confirm: true } })).statusCode).toBe(400);
    const dry = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true, dryRun: true } });
    expect(dry.json()).toMatchObject({ discordUserId: USER, dryRun: true, dmContexts: 1, dmStates: 1, dmLimits: 1 });
    expect(await readDmState(storage, USER, "aria")).toBeDefined();
    // She has notes: with no cast runtime running, her life scrub is queued for her next start.
    await homeOf({ root: storage.dataRoot }, "aria").write("MEMORY.md", "# Memory\n");
    expect(await readPendingScrubs(storage, "aria")).toEqual([]);
    const done = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ livesQueued: ["aria"] });
    // Queued before the DM state went, so it carries the name only the DM state knew.
    expect(await readPendingScrubs(storage, "aria")).toMatchObject([{ userId: USER, source: "owner_forget", names: ["Kevin"] }]);
    expect(await readDmState(storage, USER, "aria")).toBeUndefined();
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toEqual([]);
    expect((await auditStore.list()).some((record) => record.action === "people.forget")).toBe(true);
  });

  // Third review, Important 1 and 2: an archived file the process may not delete (EACCES).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a part that keeps failing never skips the life scrubs (202, pending); boots retry only it, at most three times, then an owner notice",
    async () => {
      const { root, storage } = await dmRoot(roots);
      await seedDmWorld(storage, { modelId: null });
      await mkdir(path.join(root, "user", "waifus", "aria", "life"), { recursive: true });
      await updateDmState(storage, { userId: USER, waifuId: "aria", botId: "aria-bot" }, (current) => ({ ...current, userDisplayName: "Kevin", lastInboundMessageId: "1300000000000000001" }));
      const locked = path.join(root, "user", ".archive", "living-cast", "dms", USER);
      await mkdir(locked, { recursive: true });
      await writeFile(path.join(locked, "aria.json"), JSON.stringify({ userId: USER }));
      await chmod(locked, 0o555);
      const runtime = dmRuntime(storage, new DmDiscord());
      try {
        const { app } = await api(storage, root, runtime);
        const done = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true } });
        expect(done.statusCode, done.body).toBe(202);
        expect(done.json()).toMatchObject({ pending: [{ part: "archive", error: "EACCES", failures: 1, retried: true }], lives: [{ waifuId: "aria" }] });
        // Her life scrub ran all the same (and finished: it is no longer queued).
        expect(done.json().lives[0].queued).toBeUndefined();
        expect(await readPendingScrubs(storage, "aria")).toEqual([]);
        expect(await readDmState(storage, USER, "aria")).toBeUndefined();

        // He writes again after the forget: a new DM state and reply counters.
        const stamp = new Date(Date.now() + 60_000).toISOString();
        await updateDmState(storage, { userId: USER, waifuId: "aria", botId: "aria-bot" }, (current) => ({ ...current, lastInboundMessageId: "1990000000000000001" }));
        await updateDmLimit(storage, USER, "aria", (current) => ({ ...current, replyTimestamps: [stamp] }));
        for (let boot = 0; boot < 3; boot += 1) {
          expect(await resumeForgetJobs(storage)).toBe(0);
          // Only the archive part runs again: the new chat is never touched.
          expect(await readDmState(storage, USER, "aria")).toBeDefined();
          expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toEqual([stamp]);
        }
        const [job] = await pendingForgetJobs(storage);
        expect(job).toMatchObject({ userId: USER, failures: { archive: { count: 3, error: "EACCES" } } });
        expect(job!.done).toEqual(expect.arrayContaining(["record", "floors", "dms", "dm-directory", "member-lists", "record-copies"]));
        // Given up after three tries: the owner sees why.
        const status = await app.inject({ method: "GET", url: "/api/runtime" });
        expect(status.json().discord.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`"archive" part after 3 tries (EACCES)`)]));
        expect(JSON.stringify(status.json().discord.warnings)).not.toContain(root);

        // Fixed: forgetting him again starts the job over, it finishes, and the notice goes.
        await chmod(locked, 0o755);
        const again = await app.inject({ method: "POST", url: `/api/people/${USER}/forget`, payload: { confirm: true } });
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json().pending).toBeUndefined();
        expect(await pendingForgetJobs(storage)).toEqual([]);
        expect((await app.inject({ method: "GET", url: "/api/runtime" })).json().discord.warnings).toEqual([]);
      } finally {
        await chmod(locked, 0o755).catch(() => undefined);
        await runtime.stop();
      }
    }
  );
});
