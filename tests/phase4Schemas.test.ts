import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { loadAppConfig, mergeAppConfigPatch } from "../src/config/appConfig.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { CURRENT_SCHEMA_VERSION, createRevisionedBase } from "../src/shared/schemas/common.js";
import { AppConfigSchema, DEFAULT_APP_CONFIG, UpdateAppConfigBodySchema } from "../src/shared/schemas/config.js";
import { ServerConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "323456789012345678";
const AT = "2026-10-01T00:00:00.000Z";
const base = { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 3, updatedAt: AT };

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

async function makeApp() {
  const root = await makeRoot();
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
  return { root, app: await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) }) };
}

describe("pre-Phase-4 files still parse", () => {
  it("waifu: new prompt and DM settings default in", () => {
    const old = WaifuConfigSchema.parse({
      ...base,
      id: "ella",
      name: "Ella",
      displayName: "Ella",
      contextWindow: 50,
      params: {}
    });
    // Living cast L1 dropped the per-waifu window and gateway params (living-cast-models-v1).
    expect(old).not.toHaveProperty("contextWindow");
    expect(old).not.toHaveProperty("params");
    expect(old).toMatchObject({
      verbosity: "terse",
      customInstructions: "",
      scheduleInPrompt: true,
      dm: { allowDms: false, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "" }
    });
  });

  it("waifu: prompt settings validated", () => {
    const input = { ...base, id: "a", name: "A", displayName: "A" };
    expect(() => WaifuConfigSchema.parse({ ...input, verbosity: "loud" })).toThrow();
    expect(() => WaifuConfigSchema.parse({ ...input, customInstructions: "x".repeat(4001) })).toThrow();
    expect(WaifuConfigSchema.parse({ ...input, dm: { rateLimit: null } }).dm.rateLimit).toBeNull();
  });

  it("waifu: the default dm object is not shared between parses", () => {
    const input = { ...base, id: "a", name: "A", displayName: "A" };
    const first = WaifuConfigSchema.parse(input);
    first.dm.rateLimit!.maxReplies = 999;
    expect(WaifuConfigSchema.parse(input).dm.rateLimit).toEqual({ maxReplies: 30, windowMinutes: 60 });
  });

  it("server: retired fields in old files (windows, compaction, tools, modes) are dropped on parse", () => {
    const old = ServerConfigSchema.parse({
      ...base,
      guildId: GUILD,
      contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 },
      compaction: { maxMessages: 100 },
      memoryInjectionLimit: 7,
      stageManagerEnabled: false,
      tools: { pickNextWaifu: true }
    });
    for (const key of ["contextWindows", "compaction", "memoryInjectionLimit", "stageManagerEnabled", "tools"]) expect(old).not.toHaveProperty(key);
    expect(ServerConfigSchema.parse({ ...base, guildId: GUILD, detector: { target: "" } }).detector).toEqual({ target: "" });
    expect(() => ServerConfigSchema.parse({ ...base, guildId: GUILD, detector: { target: "https://evil.test" } })).toThrow();
  });

  it("app config: an old config.toml gets the Phase 4 sections with spec defaults", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "config.toml"),
      [
        "schemaVersion = 2",
        "[http]",
        'host = "127.0.0.1"',
        "port = 4000",
        "[ocr]",
        "enabled = false",
        "[updates]",
        "enabled = true"
      ].join("\n"),
      "utf8"
    );
    const config = await loadAppConfig(root);
    expect(config.http.port).toBe(4000);
    expect(config.ocr.enabled).toBe(false);
    expect(config.compaction).toEqual({ enabled: true, triggerRatio: 0.7, maxMessages: 150, keepRecent: 30, waitTimeoutMs: 6000 });
    expect(config).not.toHaveProperty("memory");
    expect(config.life).toMatchObject({ maxConcurrentTurns: 4, maxContextTokens: 96000, maintenanceHourLocal: 5, maxInlineImagesPerEpoch: 8 });
    expect(config.discord.images).toEqual({
      maxBytes: 5 * 1024 * 1024,
      fetchTimeoutMs: 5000,
      memoryCacheMb: 64,
      diskCacheMb: 256,
      diskCacheTtlHours: 168
    });
    expect(DEFAULT_APP_CONFIG.compaction).toEqual(config.compaction);
  });

  it("app config: ranges are enforced", () => {
    expect(() => AppConfigSchema.parse({ compaction: { triggerRatio: 0.1 } })).toThrow();
    expect(() => AppConfigSchema.parse({ compaction: { keepRecent: 4 } })).toThrow();
    expect(() => AppConfigSchema.parse({ life: { maintenanceHourLocal: 24 } })).toThrow();
    expect(() => AppConfigSchema.parse({ life: { maxContextTokens: 100001 } })).toThrow();
    expect(() => AppConfigSchema.parse({ discord: { images: { maxBytes: 1024 } } })).toThrow();
  });
});

describe("partial PUTs never manufacture Phase 4 defaults", () => {
  it("app config merge keeps stored compaction/life/discord values", () => {
    const seeded = mergeAppConfigPatch(DEFAULT_APP_CONFIG, {
      compaction: { maxMessages: 90, enabled: false },
      life: { maintenanceHourLocal: 3 },
      discord: { images: { maxBytes: 1024 * 1024 } }
    });
    expect(seeded.compaction).toMatchObject({ maxMessages: 90, enabled: false, keepRecent: 30 });

    const unrelated = mergeAppConfigPatch(seeded, { ocr: { enabled: false } });
    expect(unrelated.compaction).toEqual(seeded.compaction);
    expect(unrelated.life).toEqual(seeded.life);
    expect(unrelated.discord).toEqual(seeded.discord);

    const sibling = mergeAppConfigPatch(seeded, { compaction: { keepRecent: 10 }, discord: { images: { diskCacheMb: 8 } } });
    expect(sibling.compaction).toMatchObject({ maxMessages: 90, enabled: false, keepRecent: 10 });
    expect(sibling.discord.images).toMatchObject({ maxBytes: 1024 * 1024, diskCacheMb: 8, fetchTimeoutMs: 5000 });
    expect(sibling.life.maintenanceHourLocal).toBe(3);
  });

  it("the app config body schema declares no defaults for the new sections", () => {
    expect(UpdateAppConfigBodySchema.parse({})).toEqual({});
    expect(UpdateAppConfigBodySchema.parse({ compaction: {} })).toEqual({ compaction: {} });
    expect(UpdateAppConfigBodySchema.parse({ life: {}, discord: { images: {} } })).toEqual({
      life: {},
      discord: { images: {} }
    });
    expect(() => UpdateAppConfigBodySchema.parse({ compaction: { bogus: 1 } })).toThrow();
  });

  it("PUT /api/config round-trips the new sections without resetting siblings", async () => {
    const { app } = await makeApp();
    try {
      const first = await app.inject({
        method: "PUT",
        url: "/api/config",
        payload: { compaction: { triggerRatio: 0.5 }, life: { maxSendsPerTurn: 6 } }
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "PUT", url: "/api/config", payload: { ocr: { enabled: false } } });
      expect(second.statusCode).toBe(200);
      expect(second.json().compaction).toMatchObject({ triggerRatio: 0.5, maxMessages: 150 });
      expect(second.json().life).toMatchObject({ maxSendsPerTurn: 6, maintenanceHourLocal: 5 });
      const got = (await app.inject({ method: "GET", url: "/api/config" })).json();
      expect(got.compaction.triggerRatio).toBe(0.5);
      expect(got.discord.images.maxBytes).toBe(5 * 1024 * 1024);
    } finally {
      await app.close();
    }
  });

  it("waifu PUT keeps verbosity, customInstructions, scheduleInPrompt and dm unless sent", async () => {
    const { app } = await makeApp();
    try {
      await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "ella", name: "Ella", displayName: "Ella" } });
      const url = "/api/waifus/ella";
      let waifu = (await app.inject({ method: "GET", url })).json();
      expect(waifu).toMatchObject({ verbosity: "terse", scheduleInPrompt: true, dm: { allowDms: false } });

      const seeded = await app.inject({
        method: "PUT",
        url,
        payload: {
          revision: waifu.revision,
          verbosity: "expressive",
          customInstructions: "Be kind.",
          scheduleInPrompt: false,
          dm: { allowDms: true, rateLimit: null, limitNotice: "slow down" }
        }
      });
      expect(seeded.statusCode).toBe(200);
      waifu = seeded.json();
      expect(waifu).toMatchObject({
        verbosity: "expressive",
        customInstructions: "Be kind.",
        scheduleInPrompt: false,
        dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "slow down" }
      });

      // Unrelated PUT.
      const unrelated = await app.inject({ method: "PUT", url, payload: { revision: waifu.revision, persona: "hi" } });
      expect(unrelated.statusCode).toBe(200);
      waifu = unrelated.json();
      expect(waifu).toMatchObject({
        verbosity: "expressive",
        customInstructions: "Be kind.",
        scheduleInPrompt: false,
        dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "slow down" }
      });

      // dm patch keeps siblings, including the null (unlimited) rateLimit.
      const dm = await app.inject({
        method: "PUT",
        url,
        payload: { revision: waifu.revision, dm: { notifyWhenLimited: false } }
      });
      expect(dm.json().dm).toEqual({ allowDms: true, rateLimit: null, notifyWhenLimited: false, limitNotice: "slow down", sleepNotice: "" });

      // rateLimit is a replace-wholesale leaf; null is a real value.
      const limited = await app.inject({
        method: "PUT",
        url,
        payload: { revision: dm.json().revision, dm: { rateLimit: { maxReplies: 5, windowMinutes: 10 } } }
      });
      expect(limited.json().dm.rateLimit).toEqual({ maxReplies: 5, windowMinutes: 10 });
      const unlimited = await app.inject({
        method: "PUT",
        url,
        payload: { revision: limited.json().revision, dm: { rateLimit: null } }
      });
      expect(unlimited.json().dm).toMatchObject({ rateLimit: null, allowDms: true, notifyWhenLimited: false });
    } finally {
      await app.close();
    }
  });

  it("server PUT: retired overrides are ignored, the detector override merges", async () => {
    const { app } = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      const created = await app.inject({ method: "PUT", url, payload: { paused: false, contextWindows: { waifu: 50 }, compaction: { maxMessages: 90 } } });
      expect(created.statusCode).toBe(200);
      expect(created.json()).not.toHaveProperty("contextWindows");
      expect(created.json()).not.toHaveProperty("compaction");
      const seeded = await app.inject({ method: "PUT", url, payload: { detector: { target: "openai:gpt-6-luna" } } });
      expect(seeded.json().detector).toEqual({ target: "openai:gpt-6-luna" });
      expect((await app.inject({ method: "PUT", url, payload: { detector: { target: "laya:/bin/sh" } } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("server PUT reads a legacy file that stored all three windows (they are dropped)", async () => {
    const { root, app } = await makeApp();
    try {
      const dir = path.join(root, "user", "servers", GUILD);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "server.json"),
        JSON.stringify({
          ...createRevisionedBase(),
          guildId: GUILD,
          enabled: false,
          contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 },
          channels: {}
        }),
        "utf8"
      );
      const read = await app.inject({ method: "GET", url: `/api/servers/${GUILD}` });
      expect(read.statusCode).toBe(200);
      expect(read.json()).not.toHaveProperty("contextWindows");
      const patched = await app.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: { name: "Kept" } });
      expect(patched.json()).toMatchObject({ guildId: GUILD, name: "Kept" });
    } finally {
      await app.close();
    }
  });
});
