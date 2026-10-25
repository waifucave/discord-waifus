// The life API (Living cast spec §14.1): status, the life log with DM content left out unless a
// local request asks for it (D14), owner wakes (also with Discord offline), a manual compaction, a
// reset, and the forget review lines. Temp data roots, scripted winter fakes; no live calls.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { isPrivateReviewLine, recordNeedsReview } from "../src/life/forget.js";
import { appendLifeLog, readLifeFile, readLifeLog, readLifeState, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import {
  LifeCompactResponseSchema,
  LifeLogResponseSchema,
  LifeResetResponseSchema,
  LifeStatusResponseSchema,
  NeedsReviewDismissResponseSchema,
  NeedsReviewResponseSchema,
  SearchUsageResponseSchema,
  WakeResponseSchema
} from "../src/shared/schemas/api.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { closeWorlds, KEVIN, lifeWorld, script, writeWaifuConfig, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const AT = "2026-10-24T14:00:00.000Z";
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

function runtimeState(root: string) {
  return createRuntimeState({
    pid: process.pid,
    startedAt: AT,
    packageVersion: "3.0.0-test",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
}

/** An API over the world's data root; `live` hands it the world's LivingCast (Discord connected). */
async function apiFor(w: LifeWorld, o: { live?: boolean } = {}): Promise<FastifyInstance> {
  const app = await createApiServer({
    dataRoot: w.root,
    storage: w.storage,
    runtime: runtimeState(w.root),
    ...(o.live ? { castRuntime: { cast: w.cast } as never } : {}),
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  return app;
}

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

const line = (seq: number, kind: LifeLogLine["kind"], turnId: string, message: Record<string, unknown>): LifeLogLine => ({ seq, at: AT, kind, turnId, message });

async function seedPrivateLife(w: LifeWorld): Promise<void> {
  await updateLifeState(w.storage, "aria", (state) => ({ ...state, epoch: 1, summary: "Kevin told me about his exam in DMs." }));
  await appendLifeLog(w.storage, "aria", 1, [
    line(0, "notifications", "t1", { role: "user", content: [{ type: "text", text: '<notifications>\n- dm · dm/kevin · from Kevin · "my exam is tomorrow"\n</notifications>' }] }),
    line(1, "assistant", "t1", {
      role: "assistant",
      origin: { providerId: "anthropic", modelId: "claude-haiku-5-5" },
      nativeState: { secret: "opaque" },
      content: [
        { type: "text", text: "He sounds nervous." },
        { type: "tool_use", id: "c1", name: "SendMessage", input: { place: "dm/kevin", text: "you've got this" } }
      ]
    }),
    line(2, "tool_results", "t1", { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "sent #a1" }] }),
    line(3, "notifications", "t2", { role: "user", content: [{ type: "text", text: '- mention · bake-club/#general · from Mina · "cake?"' }] }),
    line(4, "assistant", "t2", { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "SendMessage", input: { place: "bake-club/#general", text: "lemon cake!" } }] }),
    line(5, "tool_results", "t2", { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "sent #a2" }] })
  ]);
  await enqueueWake(w.storage, "aria", { id: "w-dm", reason: "dm", placeKey: `dm_${KEVIN}_aria`, fromName: "Kevin", preview: "can we talk privately", at: AT });
  await enqueueWake(w.storage, "aria", { id: "w-room", reason: "mention", placeKey: "g_1_2", fromName: "Mina", preview: "cake?", at: AT });
}

describe("GET /api/waifus/:id/life", () => {
  it("shows status, queue and today's cost; DM previews and the summary only for a local includePrivate", async () => {
    const w = await lifeWorld(roots, {});
    await seedPrivateLife(w);
    const app = await apiFor(w);
    const response = await app.inject({ method: "GET", url: "/api/waifus/aria/life" });
    expect(response.statusCode).toBe(200);
    const body = LifeStatusResponseSchema.parse(response.json());
    expect(body).toMatchObject({ waifuId: "aria", displayName: "Aria", enabled: true, epoch: 1, logLines: 6, runtime: { running: false, busy: false } });
    expect(body.summary).toEqual({ text: null, hidden: true });
    const dmWake = body.queue.wakes.find((wake) => wake.id === "w-dm")!;
    expect(dmWake).toMatchObject({ dm: true, from: "Kevin" });
    expect(dmWake.preview).toBeUndefined();
    expect(body.queue.wakes.find((wake) => wake.id === "w-room")?.preview).toBe("cake?");
    expect(JSON.stringify(body)).not.toContain("exam");

    const open = LifeStatusResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life?includePrivate=1" })).json());
    expect(open.summary.text).toContain("exam");
    expect(open.queue.wakes.find((wake) => wake.id === "w-dm")?.preview).toBe("can we talk privately");
  });

  it("refuses includePrivate over Remote Access and explains why", async () => {
    const w = await lifeWorld(roots, {});
    const app = await apiFor(w);
    const response = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/waifus/aria/life?includePrivate=1" });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: "PrivateContentLocalOnly" });
    expect(JSON.parse(response.body).message).toMatch(/only shown on the host/u);
    const plain = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/waifus/aria/life" });
    expect(plain.statusCode).toBe(200);
  });

  it("validates the waifu id and answers 404 for an unknown waifu", async () => {
    const w = await lifeWorld(roots, {});
    const app = await apiFor(w);
    expect((await app.inject({ method: "GET", url: "/api/waifus/bad%20id/life" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/waifus/nobody/life" })).statusCode).toBe(404);
  });
});

describe("GET /api/waifus/:id/life/log", () => {
  it("leaves DM tool results, DM send arguments and her text in a DM turn out; never returns nativeState", async () => {
    const w = await lifeWorld(roots, {});
    await seedPrivateLife(w);
    const app = await apiFor(w);
    const body = LifeLogResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/log" })).json());
    const text = JSON.stringify(body);
    expect(text).not.toContain("my exam is tomorrow");
    expect(text).not.toContain("you've got this");
    expect(text).not.toContain("nervous");
    expect(text).not.toContain("opaque");
    expect(text).toContain("lemon cake!");
    expect(text).toContain('\\"cake?\\"');
    expect(body.redactedBlocks).toBe(3);
    expect(body.lines[1]).toMatchObject({ dm: true, role: "assistant", origin: { providerId: "anthropic" } });
    expect(body.lines[4]).toMatchObject({ dm: false });

    const open = LifeLogResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/log?includePrivate=1" })).json());
    expect(JSON.stringify(open)).toContain("you've got this");
    expect(JSON.stringify(open)).toContain("nervous");
    expect(JSON.stringify(open)).not.toContain("opaque");
    expect(open.redactedBlocks).toBe(0);
  });

  it("pages backwards with before and limit", async () => {
    const w = await lifeWorld(roots, {});
    await seedPrivateLife(w);
    const app = await apiFor(w);
    const last = LifeLogResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/log?limit=2" })).json());
    expect(last.lines.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(last.hasMore).toBe(true);
    const older = LifeLogResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/log?limit=10&before=4" })).json());
    expect(older.lines.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(older.hasMore).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/waifus/aria/life/log?epoch=9" })).statusCode).toBe(404);
  });
});

describe("owner actions on a life", () => {
  it("queues an owner wake with Discord offline", async () => {
    const w = await lifeWorld(roots, {});
    const app = await apiFor(w);
    const response = await app.inject({ method: "POST", url: "/api/waifus/aria/wake", payload: { note: "say hi" } });
    expect(response.statusCode).toBe(200);
    expect(WakeResponseSchema.parse(response.json())).toMatchObject({ outcome: "queued_offline" });
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([expect.objectContaining({ reason: "owner", note: "say hi" })]);
    expect((await app.inject({ method: "POST", url: "/api/waifus/ghost/wake", payload: {} })).statusCode).toBe(404);
  });

  it("routes the wake through the live cast when Discord is connected", async () => {
    const w = await lifeWorld(roots, {});
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const app = await apiFor(w, { live: true });
    const body = WakeResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/wake", payload: {} })).json());
    expect(body.outcome).toBe("queued");
  });

  it("compact and reset need the live cast", async () => {
    const w = await lifeWorld(roots, {});
    const app = await apiFor(w);
    for (const url of ["/api/waifus/aria/life/compact", "/api/waifus/aria/life/reset"]) {
      const response = await app.inject({ method: "POST", url, payload: { confirm: true } });
      expect(response.statusCode, url).toBe(409);
      expect(response.json()).toMatchObject({ error: "RuntimeOffline" });
    }
  });

  it("compacts her life on request, then resets it to an empty epoch", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello"), textTurn("Earlier: I said hello to the bake club.")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const app = await apiFor(w, { live: true });
    const early = await app.inject({ method: "POST", url: "/api/waifus/aria/life/compact", payload: {} });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/has not started/u);

    await enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "owner", note: "first", at: w.clock.now().toISOString() });
    await w.cast.life("aria").runNow();
    const before = await readLifeState(w.storage, "aria");
    const compacted = LifeCompactResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/life/compact", payload: {} })).json());
    expect(compacted).toMatchObject({ state: "done", epoch: before.epoch + 1, summarized: true });
    const after = await readLifeState(w.storage, "aria");
    expect(after.summary).toContain("bake club");
    expect(after.lastCompaction).toMatchObject({ reason: "manual", summarized: true });

    expect((await app.inject({ method: "POST", url: "/api/waifus/aria/life/reset", payload: {} })).statusCode).toBe(400);
    const reset = LifeResetResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/life/reset", payload: { confirm: true } })).json());
    expect(reset).toEqual({ waifuId: "aria", epoch: after.epoch + 1, deferred: false });
    const fresh = await readLifeState(w.storage, "aria");
    expect(fresh.summary).toBeNull();
    expect(fresh.lastCompaction).toMatchObject({ reason: "reset" });
  });

  it("refuses to compact a waifu without a model", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", model: undefined }] });
    const app = await apiFor(w, { live: true });
    const response = await app.inject({ method: "POST", url: "/api/waifus/aria/life/compact", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/no offered model/u);
  });

  it("a stopping cast refuses owner actions: the wake waits in her queue, compact and reset are RuntimeOffline (review I-4, repro r11)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello"), textTurn("Earlier: I said hello.")) });
    await enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "owner", note: "first", at: w.clock.now().toISOString() });
    await w.cast.life("aria").runNow();
    const before = await readLifeState(w.storage, "aria");
    const app = await apiFor(w, { live: true });
    // The reload window: the old cast stays reachable until stop() returns.
    await w.cast.stop();
    expect(w.cast.isStopped).toBe(true);
    const wake = await app.inject({ method: "POST", url: "/api/waifus/aria/wake", payload: { note: "still there?" } });
    expect(WakeResponseSchema.parse(wake.json())).toMatchObject({ outcome: "queued_offline" });
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([expect.objectContaining({ reason: "owner", note: "still there?" })]);
    for (const url of ["/api/waifus/aria/life/compact", "/api/waifus/aria/life/reset"]) {
      const response = await app.inject({ method: "POST", url, payload: { confirm: true } });
      expect(response.statusCode, url).toBe(409);
      expect(response.json(), url).toMatchObject({ error: "RuntimeOffline" });
    }
    const after = await readLifeState(w.storage, "aria");
    expect(after.epoch).toBe(before.epoch);
    expect(after.summary).toBe(before.summary);
    // No new life is created on a stopped cast.
    (w.cast as unknown as { lives: Map<string, unknown> }).lives.delete("aria");
    expect(() => w.cast.life("aria")).toThrow(/stopping/u);
    await expect(w.cast.ownerWake("aria", "hi")).rejects.toThrow(/stopping/u);
  });

  it("reports a compaction a pause or shutdown stopped as aborted, not done", async () => {
    const w = await lifeWorld(roots, {});
    const cast = { compactNow: async () => ({ epoch: 3, summarized: false, aborted: true }) };
    const app = await createApiServer({ dataRoot: w.root, storage: w.storage, runtime: runtimeState(w.root), castRuntime: { cast } as never, remoteTrust: { isAuthorized: () => true } });
    apps.push(app);
    const response = LifeCompactResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/life/compact", payload: {} })).json());
    expect(response).toMatchObject({ state: "aborted", summarized: false });
  });

  it("a reset without a model starts its epoch as a reset: the old log stays, and a compact starts that epoch without summarising it", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello"), textTurn("Earlier: I said hello.")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const app = await apiFor(w, { live: true });
    await enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "owner", note: "first", at: w.clock.now().toISOString() });
    await w.cast.life("aria").runNow();
    const before = await readLifeState(w.storage, "aria");
    const oldLog = await readLifeLog(w.storage, "aria", before.epoch);
    expect(oldLog.length).toBeGreaterThan(0);
    await writeWaifuConfig(w.storage, { id: "aria", name: "Aria", botId: "aria-bot", model: undefined });
    const reset = LifeResetResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/life/reset", payload: { confirm: true } })).json());
    expect(reset).toMatchObject({ deferred: true, epoch: before.epoch });
    expect(await readLifeState(w.storage, "aria")).toMatchObject({ summary: null, pendingEpochStart: true, pendingEpochReason: "reset" });
    // A model again, and the owner compacts: the pending epoch starts; the old log is not summarised.
    await writeWaifuConfig(w.storage, { id: "aria", name: "Aria", botId: "aria-bot" });
    const compacted = LifeCompactResponseSchema.parse((await app.inject({ method: "POST", url: "/api/waifus/aria/life/compact", payload: {} })).json());
    expect(compacted).toMatchObject({ state: "done", epoch: before.epoch + 1, summarized: false });
    const after = await readLifeState(w.storage, "aria");
    expect(after.summary).toBeNull();
    expect(after.pendingEpochStart).toBe(false);
    expect(after.pendingEpochReason).toBeUndefined();
    expect(after.lastCompaction).toMatchObject({ reason: "reset", summarized: false, fromEpoch: before.epoch });
    // Kept the usual 7 days, unlike a forget's.
    expect(await readLifeLog(w.storage, "aria", before.epoch)).toEqual(oldLog);
  });
});

describe("GET /api/search/usage", () => {
  it("shows a DM turn's queries only on a local reveal (review: DM turns)", async () => {
    const w = await lifeWorld(roots, {});
    await mkdir(path.join(w.root, "user", "search"), { recursive: true });
    await writeFile(
      path.join(w.root, "user", "search", "usage.json"),
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        updatedAt: AT,
        day: "2026-10-24",
        searches: 2,
        fetches: 0,
        recent: [
          { at: AT, waifuId: "aria", kind: "search", query: "how to tell a friend you are pregnant", ok: true, turnId: "t1", dm: true },
          { at: AT, waifuId: "aria", kind: "search", query: "lemon tart", ok: true, turnId: "t2" }
        ]
      })
    );
    const app = await apiFor(w);
    const plain = SearchUsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/search/usage" })).json());
    expect(plain.includePrivate).toBe(false);
    expect(plain.recent.map((entry) => entry.query)).toEqual(["lemon tart", "[private chat redacted]"]);
    expect(JSON.stringify(plain)).not.toContain("pregnant");
    expect(JSON.stringify(plain)).not.toContain("turnId");
    const local = SearchUsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/search/usage?includePrivate=1" })).json());
    expect(local.recent[1]).toMatchObject({ query: "how to tell a friend you are pregnant", dm: true });
    const remoteAsk = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/search/usage?includePrivate=1" });
    expect(remoteAsk.statusCode).toBe(403);
    const remotePlain = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/search/usage" });
    expect(remotePlain.body).not.toContain("pregnant");
  });
});

describe("forget review lines", () => {
  it("lists review lines and dismisses one by id; the dismissal answers with the id only (review I-3)", async () => {
    const w = await lifeWorld(roots, {});
    await recordNeedsReview(w.storage, "aria", new Date(AT), "owner", [
      { where: "notes/people/sam.md", line: "Sam's cousin bakes too" },
      { where: "summary", line: "Sam came by" },
      { where: "wakes", line: "Sam can we talk? I think I'm pregnant" }
    ]);
    const app = await apiFor(w);
    const listed = NeedsReviewResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/needs-review" })).json());
    expect(listed.items.map((item) => item.line)).toEqual(["Sam's cousin bakes too", "[private chat redacted]", "[private chat redacted]"]);
    const id = listed.items[0]!.id;
    const dismissed = await app.inject({ method: "DELETE", url: `/api/waifus/aria/life/needs-review/${id}` });
    expect(dismissed.statusCode).toBe(200);
    expect(NeedsReviewDismissResponseSchema.strict().parse(dismissed.json())).toEqual({ waifuId: "aria", dismissed: id });
    // The mutation layer keeps the response for a day: no review line rides in it (repro r10).
    const ledger = await readFile(path.join(w.root, "app/remote-access/operations/ledger.json"), "utf8").catch(() => "");
    expect(ledger).not.toContain("pregnant");
    expect(ledger).not.toContain("Sam came by");
    expect((await app.inject({ method: "DELETE", url: `/api/waifus/aria/life/needs-review/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/waifus/aria/life/needs-review/not-hex" })).statusCode).toBe(400);
    const status = LifeStatusResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life" })).json());
    expect(status.counts.needsReview).toBe(2);
  });

  it("keeps summary lines and other people's DM wake previews private: local includePrivate only (review I-3, repros r4/r4b)", async () => {
    const w = await lifeWorld(roots, {});
    // A summary line after a DM forget (a shared name), and a line recorded before lines were marked.
    await recordNeedsReview(w.storage, "aria", new Date(AT), "dm_forget_everything", [
      { where: "summary", line: "In DMs, Sam from the bake club told me about his court date on Friday." },
      { where: "system prompt", line: "dm/sam — Sam (DM)" },
      { where: "notes/people/sam.md", line: "Sam bakes on Sundays" }
    ]);
    const app = await apiFor(w);
    const plain = NeedsReviewResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/needs-review" })).json());
    expect(plain.includePrivate).toBe(false);
    expect(JSON.stringify(plain)).not.toContain("court date");
    expect(JSON.stringify(plain)).not.toContain("dm/sam");
    expect(plain.items.map((item) => item.private ?? false)).toEqual([true, true, false]);
    const local = NeedsReviewResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life/needs-review?includePrivate=1" })).json());
    expect(local.includePrivate).toBe(true);
    expect(local.items[0]!.line).toContain("court date");
    // The same ids either way, so a hidden line can be dismissed.
    expect(local.items.map((item) => item.id)).toEqual(plain.items.map((item) => item.id));
    // Remote Access never reads them, and cannot ask (403).
    const remotePlain = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/waifus/aria/life/needs-review" });
    expect(remotePlain.statusCode).toBe(200);
    expect(remotePlain.body).not.toContain("court date");
    const remoteAsk = await dispatchInternal(app, remote(), undefined, { method: "GET", url: "/api/waifus/aria/life/needs-review?includePrivate=1" });
    expect(remoteAsk.statusCode).toBe(403);
    expect(JSON.parse(remoteAsk.body)).toMatchObject({ error: "PrivateContentLocalOnly" });
  });

  it("a line from her queue (a wake preview may quote a DM) is private, also one recorded unmarked (repro r4b)", () => {
    expect(isPrivateReviewLine({ where: "wakes", line: "Sam can we talk? I think I'm pregnant" })).toBe(true);
    expect(isPrivateReviewLine({ where: "summary", line: "Sam came by" })).toBe(true);
    expect(isPrivateReviewLine({ where: "watches", line: "biopsy", private: true })).toBe(true);
    expect(isPrivateReviewLine({ where: "system prompt", line: "DM/Sam — Sam" })).toBe(true);
    expect(isPrivateReviewLine({ where: "notes/people/sam.md", line: "Sam bakes on Sundays" })).toBe(false);
    expect(isPrivateReviewLine({ where: "reminders", line: "bring Sam's tray back" })).toBe(false);
  });

  it("the forget response never carries a private review line (review I-3)", async () => {
    const w = await lifeWorld(roots, {});
    const lives = [{ waifuId: "aria", removedLines: 1, removedSentences: 0, needsReview: [{ where: "summary", line: "Sam told me about his court date" }, { where: "wakes", line: "Sam? I'm pregnant", private: true as const }, { where: "notes/a.md", line: "Sam bakes" }] }];
    const cast = { forgetUser: async (input: { discordUserId: string; dryRun: boolean }) => ({ discordUserId: input.discordUserId, dryRun: false, dmContexts: 0, dmStates: 0, dmLimits: 0, cachedImages: 0, lives }) };
    const app = await createApiServer({ dataRoot: w.root, storage: w.storage, runtime: runtimeState(w.root), castRuntime: cast as never, remoteTrust: { isAuthorized: () => true } });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: `/api/people/${KEVIN}/forget`, payload: { confirm: true } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { lives: Array<{ needsReview: Array<{ line: string; private?: boolean }> }> };
    expect(body.lives[0]!.needsReview).toEqual([
      { where: "summary", line: "[private chat redacted]", private: true },
      { where: "wakes", line: "[private chat redacted]", private: true },
      { where: "notes/a.md", line: "Sam bakes" }
    ]);
    const ledger = await readFile(path.join(w.root, "app/remote-access/operations/ledger.json"), "utf8").catch(() => "");
    expect(ledger).not.toContain("court date");
    expect(ledger).not.toContain("pregnant");
  });

  it("counts today's searches from her usage file and today's cost from the ledger", async () => {
    const w = await lifeWorld(roots, {});
    const today = new Date().toISOString();
    await updateLifeFile(w.storage, "aria", "usage", (usage) => ({ ...usage, day: today.slice(0, 10), searches: 2, fetches: 1 }));
    await mkdir(path.join(w.root, "user", "usage"), { recursive: true });
    await writeFile(
      path.join(w.root, "user", "usage", `${today.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ at: today, purpose: "life", waifuId: "aria", providerId: "anthropic", modelId: "claude-haiku-5-5", status: "ok", usageKnown: true, inputTokens: 10, outputTokens: 5, costUsd: 0.25, durationMs: 5 })}\n`
    );
    const app = await createApiServer({ dataRoot: w.root, storage: w.storage, runtime: runtimeState(w.root) });
    apps.push(app);
    const status = LifeStatusResponseSchema.parse((await app.inject({ method: "GET", url: "/api/waifus/aria/life" })).json());
    expect(status.today.calls).toBe(1);
    expect(status.today.costUsd).toBeCloseTo(0.25);
  });
});
