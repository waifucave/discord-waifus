// Cast-wide routes (Living cast spec §14.1): usage grouped by local day from the usage ledger, web
// search usage, the detector's target and history, unfinished owner forgets and owner notices.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { runMigrations } from "../src/backend/migrations.js";
import { castHealth } from "../src/backend/castHealth.js";
import { ensureDataLayout } from "../src/config/layout.js";
import {
  DetectorConfigResponseSchema,
  DetectorHistoryResponseSchema,
  ForgetJobsResponseSchema,
  OwnerNoticesResponseSchema,
  SearchUsageResponseSchema,
  UsageResponseSchema
} from "../src/shared/schemas/api.js";
import { StorageService } from "../src/storage/storageService.js";
import { ASSISTANT_USAGE_MAX_GROUPS, usageForAssistant } from "../src/api/assistant/tools.js";
import { MAX_USAGE_GROUPS } from "../src/orchestration/usageReport.js";
import { instantOfLocal, localDayKey } from "../src/life/clock.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function setup(): Promise<{ root: string; app: FastifyInstance; storage: StorageService }> {
  const root = await makeTempRoot("waifus-cast-api-");
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const app = await createApiServer({
    dataRoot: root,
    storage,
    runtime: createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "3.0.0-test",
      port: 3888,
      dataRoot: root,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    })
  });
  apps.push(app);
  return { root, app, storage };
}

function ledgerLine(at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ at, purpose: "life", waifuId: "aria", providerId: "anthropic", modelId: "claude-haiku-5-5", status: "ok", usageKnown: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, costUsd: 0.01, durationMs: 3, ...extra });
}

async function writeLedger(root: string, day: string, lines: string[]): Promise<void> {
  await mkdir(path.join(root, "user", "usage"), { recursive: true });
  await writeFile(path.join(root, "user", "usage", `${day}.jsonl`), `${lines.join("\n")}\n`);
}

describe("GET /api/usage", () => {
  it("groups ledger lines by local day of the requested zone, reading the UTC files around the edges", async () => {
    const { root, app } = await setup();
    // 23:30 UTC on the 23rd is the 24th in Tokyo; 16:00 UTC on the 24th is the 25th there.
    await writeLedger(root, "2026-10-23", [ledgerLine("2026-10-23T23:30:00.000Z"), "{torn"]);
    await writeLedger(root, "2026-10-24", [
      ledgerLine("2026-10-24T10:00:00.000Z", { waifuId: "mina", purpose: "web", costUsd: undefined }),
      ledgerLine("2026-10-24T16:00:00.000Z", { status: "failed" })
    ]);
    const tokyo = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-10-24&to=2026-10-25&tz=Asia/Tokyo" })).json());
    expect(tokyo.groups.map((group) => [group.key[0], group.calls])).toEqual([["2026-10-24", 2], ["2026-10-25", 1]]);
    expect(tokyo.totals).toMatchObject({ calls: 3, inputTokens: 300, cacheReadTokens: 150, costKnownCalls: 2, unpricedCalls: 1, failedCalls: 1 });
    expect(tokyo.totals.costUsd).toBeCloseTo(0.02);
    expect(tokyo.skippedLines).toBe(1);

    const byWaifu = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-10-23&to=2026-10-24&tz=UTC&groupBy=waifu,purpose" })).json());
    expect(byWaifu.groups.map((group) => group.key)).toEqual([["aria", "life"], ["mina", "web"]]);
    const filtered = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-10-23&to=2026-10-24&tz=UTC&waifuId=mina" })).json());
    expect(filtered.totals.calls).toBe(1);
  });

  it("rejects bad ranges, keys and zones", async () => {
    const { app } = await setup();
    for (const query of ["groupBy=color", "groupBy=day,waifu,model", "tz=Mars/Base", "from=2026-02-31&to=2026-03-01", "from=2024-01-01&to=2026-01-01", "from=2026-10-25&to=2026-10-24"]) {
      const response = await app.inject({ method: "GET", url: `/api/usage?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
    const plain = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage" })).json());
    expect(plain.groupBy).toEqual(["day"]);
  });

  it("streams the ledger and keeps bounded results: capped groups, groupBy=turn over at most 31 days (review I-5, repro r7)", async () => {
    const { root, app } = await setup();
    // 1,500 turns in one day, an oversized line and a torn one.
    const lines = Array.from({ length: 1500 }, (_, i) => ledgerLine(new Date(Date.UTC(2026, 9, 24, 0, 0, i)).toISOString(), { turnId: `t${i}` }));
    lines.push(ledgerLine("2026-10-24T12:00:00.000Z", { turnId: "x".repeat(70_000) }), "{torn");
    await writeLedger(root, "2026-10-24", lines);
    const byTurn = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-10-24&to=2026-10-24&tz=UTC&groupBy=turn" })).json());
    expect(byTurn.totals.calls).toBe(1500);
    expect(byTurn.skippedLines).toBe(2);
    expect(byTurn.groups).toHaveLength(MAX_USAGE_GROUPS + 1);
    expect(byTurn.groupsCapped).toBe(true);
    const other = byTurn.groups.find((group) => group.key[0] === "(other)");
    expect(other?.calls).toBe(1500 - MAX_USAGE_GROUPS);
    expect(byTurn.groups.reduce((sum, group) => sum + group.calls, 0)).toBe(1500);
    const tooLong = await app.inject({ method: "GET", url: "/api/usage?from=2026-09-01&to=2026-10-24&tz=UTC&groupBy=turn" });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().message).toMatch(/31 days/u);
    // A year by day stays fine.
    const year = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2025-10-25&to=2026-10-24&tz=UTC" })).json());
    expect(year.totals.calls).toBe(1500);
    expect(year.groupsCapped).toBeUndefined();
  });

  it("starts a local day on that day when DST skips its midnight (review: DST, repro r6)", async () => {
    // America/Santiago, 2026-09-06: 00:00 local jumps to 01:00.
    const start = instantOfLocal("America/Santiago", 2026, 9, 6, 0, 0);
    expect(start.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localDayKey(start, "America/Santiago")).toBe("2026-09-06");
    expect(localDayKey(new Date(start.getTime() - 1), "America/Santiago")).toBe("2026-09-05");
    // An ordinary wall time, and one that occurs twice (DST ends: its first occurrence).
    expect(instantOfLocal("Europe/Berlin", 2026, 7, 1, 12, 0).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(instantOfLocal("Europe/Berlin", 2026, 10, 25, 2, 30).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // 02:30 does not exist that night: it reads as 03:30 (moved forward by the gap).
    expect(instantOfLocal("Europe/Berlin", 2026, 3, 29, 2, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    const { root, app } = await setup();
    // 23:30 local on Sep 5 is 03:30Z on Sep 6: it belongs to Sep 5.
    await writeLedger(root, "2026-09-06", [ledgerLine("2026-09-06T03:30:00.000Z")]);
    const sep5 = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-09-05&to=2026-09-05&tz=America/Santiago" })).json());
    expect(sep5.groups.map((group) => [group.key[0], group.calls])).toEqual([["2026-09-05", 1]]);
    const sep6 = UsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/usage?from=2026-09-06&to=2026-09-06&tz=America/Santiago" })).json());
    expect(sep6.totals.calls).toBe(0);
  });

  it("get_usage gives the assistant the costliest groups only", () => {
    const groups = Array.from({ length: 100 }, (_, i) => ({ key: [`t${i}`], calls: 1, costUsd: i / 100 }));
    const body = JSON.stringify({ from: "2026-10-24", to: "2026-10-24", totals: { calls: 100 }, groups });
    const trimmed = JSON.parse(usageForAssistant(200, body)) as { groups: Array<{ key: string[] }>; omittedGroups: number; totals: { calls: number } };
    expect(trimmed.groups).toHaveLength(ASSISTANT_USAGE_MAX_GROUPS);
    expect(trimmed.groups[0]!.key).toEqual(["t99"]);
    expect(trimmed.omittedGroups).toBe(100 - ASSISTANT_USAGE_MAX_GROUPS);
    expect(trimmed.totals.calls).toBe(100);
    const small = JSON.stringify({ groups: groups.slice(0, 3) });
    expect(usageForAssistant(200, small)).toBe(small);
    expect(usageForAssistant(400, '{"error":"x"}')).toBe('{"error":"x"}');
  });
});

describe("search, detector, forget jobs and owner notices", () => {
  it("reports today's search counts with the caps, newest queries first", async () => {
    const { root, app } = await setup();
    const today = new Date().toISOString();
    await mkdir(path.join(root, "user", "search"), { recursive: true });
    await writeFile(
      path.join(root, "user", "search", "usage.json"),
      JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: today, day: "2000-01-01", searches: 9, fetches: 4, recent: [{ at: today, waifuId: "aria", kind: "search", query: "lemon tart", ok: true }, { at: today, waifuId: "aria", kind: "fetch", query: "https://example.com", ok: false }] })
    );
    const body = SearchUsageResponseSchema.parse((await app.inject({ method: "GET", url: "/api/search/usage" })).json());
    expect(body).toMatchObject({ searches: 0, fetches: 0, exaKeyConfigured: false, limits: { maxPerDay: 50, maxPerWaifuPerDay: 20, fetchMaxPerTurn: 3 } });
    expect(body.recent.map((entry) => entry.query)).toEqual(["https://example.com", "lemon tart"]);
  });

  it("reads and writes the detector target; refuses unknown targets", async () => {
    const { root, app } = await setup();
    const initial = DetectorConfigResponseSchema.parse((await app.inject({ method: "GET", url: "/api/detector/config" })).json());
    expect(initial.target).toBe(initial.default);
    expect((await app.inject({ method: "PUT", url: "/api/detector/config", payload: { target: "anthropic:claude" } })).statusCode).toBe(400);
    const saved = DetectorConfigResponseSchema.parse((await app.inject({ method: "PUT", url: "/api/detector/config", payload: { target: "" } })).json());
    expect(saved.target).toBe("");
    expect(await readFile(path.join(root, "config.toml"), "utf8")).toMatch(/\[detector\]\s+target = ""/u);
  });

  it("returns a server's detector history, newest first", async () => {
    const { root, app } = await setup();
    const guildId = "100000000000000001";
    await mkdir(path.join(root, "user", "servers", guildId), { recursive: true });
    await writeFile(
      path.join(root, "user", "servers", guildId, "detector-history.json"),
      JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: new Date().toISOString(), guildId, entries: [
        { at: "2026-10-24T10:00:00.000Z", channelId: "200000000000000002", burstMessageIds: ["1"], choice: "human", probabilities: {} },
        { at: "2026-10-24T11:00:00.000Z", channelId: "200000000000000002", burstMessageIds: ["2"], choice: "waifu_0", probabilities: { waifu_0: 0.9 }, woke: ["aria"] }
      ] })
    );
    const body = DetectorHistoryResponseSchema.parse((await app.inject({ method: "GET", url: `/api/detector/history?guildId=${guildId}` })).json());
    expect(body.entries.map((entry) => entry.choice)).toEqual(["waifu_0", "human"]);
    expect((await app.inject({ method: "GET", url: "/api/detector/history?guildId=../x" })).statusCode).toBe(400);
  });

  it("lists unfinished forget jobs and the owner notices, including incomplete migrations and given-up parts", async () => {
    const { root, app, storage } = await setup();
    await mkdir(path.join(root, "user", "people"), { recursive: true });
    await writeFile(
      path.join(root, "user", "people", "forget-jobs.json"),
      JSON.stringify({ jobs: [{ userId: "300000000000000003", at: "2026-10-24T10:00:00.000Z", done: ["record", "floors"], failures: { archive: { count: 3, error: "EACCES", at: "2026-10-24T10:01:00.000Z" }, dms: { count: 1, error: "EBUSY", at: "2026-10-24T10:01:00.000Z" } } }] })
    );
    await writeFile(path.join(root, "user", "people", "forgotten.json.corrupt-2026-10-24T10-00-00-000Z"), "{torn");
    // A migration step that left unreadable data alone is recorded for the owner, then cleared.
    const step = { id: "test-incomplete-v1", frequency: "once" as const, run: async () => ({ incomplete: "1 file could not be parsed" }) };
    await runMigrations(root, { appVersion: "3.0.0-test", steps: [step] });

    const jobs = ForgetJobsResponseSchema.parse((await app.inject({ method: "GET", url: "/api/people/forget-jobs" })).json());
    expect(jobs.jobs[0]!.pending.find((part) => part.part === "archive")).toEqual({ part: "archive", error: "EACCES", failures: 3, retried: false });
    expect(jobs.jobs[0]!.pending.find((part) => part.part === "dms")).toMatchObject({ retried: true, failures: 1 });

    const notices = OwnerNoticesResponseSchema.parse((await app.inject({ method: "GET", url: "/api/owner-notices" })).json());
    expect(notices.notices.some((notice) => notice.includes('"archive" part') && notice.includes("EACCES"))).toBe(true);
    expect(notices.incompleteMigrations).toEqual([expect.objectContaining({ step: "test-incomplete-v1", detail: "1 file could not be parsed" })]);
    expect(notices.corruptForgetCopies).toBe(1);
    expect(notices.intake).toMatchObject({ paused: false, pausedAt: null });

    await runMigrations(root, { appVersion: "3.0.0-test", steps: [{ ...step, run: async () => "converted" }] });
    expect((await castHealth(storage, { paused: false })).incompleteMigrations).toEqual([]);
  });

  it("names an enabled waifu whose linked bot cannot log in (not one that speaks through the House bot)", async () => {
    const { app } = await setup();
    for (const id of ["aria", "mina", "solo"]) {
      expect((await app.inject({ method: "POST", url: "/api/waifus", payload: { id, name: id, displayName: id } })).statusCode).toBe(201);
    }
    expect((await app.inject({ method: "PUT", url: "/api/discord-bots", payload: { waifus: [{ id: "aria-bot", displayName: "Aria", enabled: true }, { id: "mina-bot", displayName: "Mina", enabled: false, token: "MTAx.fake-token" }] } })).statusCode).toBe(200);
    for (const [id, botId] of [["aria", "aria-bot"], ["mina", "mina-bot"]] as const) {
      const current = (await app.inject({ method: "GET", url: `/api/waifus/${id}` })).json() as { revision: number };
      expect((await app.inject({ method: "PUT", url: `/api/waifus/${id}`, payload: { revision: current.revision, botId } })).statusCode).toBe(200);
    }
    const notices = OwnerNoticesResponseSchema.parse((await app.inject({ method: "GET", url: "/api/owner-notices" })).json());
    expect(notices.waifusWithoutBot).toEqual([
      { waifuId: "aria", reason: "bot_no_token" },
      { waifuId: "mina", reason: "bot_disabled" }
    ]);
    expect(notices.notices.filter((notice) => notice.includes("nothing she sends reaches Discord"))).toHaveLength(2);
    expect(JSON.stringify(notices)).not.toContain("fake-token");
  });
});
