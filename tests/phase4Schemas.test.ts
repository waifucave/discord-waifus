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
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  return { root, app: await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) }) };
}

describe("pre-Phase-4 files still parse", () => {
  it("waifu: new prompt and DM settings default in", () => {
    const old = WaifuConfigSchema.parse({
      ...base,
      id: "aria",
      name: "Aria",
      displayName: "Aria",
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

  it("server: old files with all three windows keep them; missing keys are simply unset", () => {
    const old = ServerConfigSchema.parse({
      ...base,
      guildId: GUILD,
      contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 }
    });
    expect(old.contextWindows).toEqual({ orchestrator: 20, waifu: 50, stageManager: 80 });
    expect(old.compaction).toBeUndefined();
    expect(ServerConfigSchema.parse({ ...base, guildId: GUILD }).contextWindows).toEqual({});
  });

  it("server: compaction override is a validated partial", () => {
    const parsed = ServerConfigSchema.parse({ ...base, guildId: GUILD, compaction: { maxMessages: 100 } });
    expect(parsed.compaction).toEqual({ maxMessages: 100 });
    expect(() => ServerConfigSchema.parse({ ...base, guildId: GUILD, compaction: { triggerRatio: 2 } })).toThrow();
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
    expect(config.memory).toEqual({
      dreamHourLocal: 5,
      maxPinnedInjected: 6,
      maxMemoryNotesPerEpoch: 6,
      maxInlineImagesPerEpoch: 8,
      dmInjectionLimit: 12
    });
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
    expect(() => AppConfigSchema.parse({ memory: { dreamHourLocal: 24 } })).toThrow();
    expect(() => AppConfigSchema.parse({ memory: { dmInjectionLimit: 0 } })).toThrow();
    expect(() => AppConfigSchema.parse({ discord: { images: { maxBytes: 1024 } } })).toThrow();
  });
});

describe("partial PUTs never manufacture Phase 4 defaults", () => {
  it("app config merge keeps stored compaction/memory/discord values", () => {
    const seeded = mergeAppConfigPatch(DEFAULT_APP_CONFIG, {
      compaction: { maxMessages: 90, enabled: false },
      memory: { dreamHourLocal: 3 },
      discord: { images: { maxBytes: 1024 * 1024 } }
    });
    expect(seeded.compaction).toMatchObject({ maxMessages: 90, enabled: false, keepRecent: 30 });

    const unrelated = mergeAppConfigPatch(seeded, { ocr: { enabled: false } });
    expect(unrelated.compaction).toEqual(seeded.compaction);
    expect(unrelated.memory).toEqual(seeded.memory);
    expect(unrelated.discord).toEqual(seeded.discord);

    const sibling = mergeAppConfigPatch(seeded, { compaction: { keepRecent: 10 }, discord: { images: { diskCacheMb: 8 } } });
    expect(sibling.compaction).toMatchObject({ maxMessages: 90, enabled: false, keepRecent: 10 });
    expect(sibling.discord.images).toMatchObject({ maxBytes: 1024 * 1024, diskCacheMb: 8, fetchTimeoutMs: 5000 });
    expect(sibling.memory.dreamHourLocal).toBe(3);
  });

  it("the app config body schema declares no defaults for the new sections", () => {
    expect(UpdateAppConfigBodySchema.parse({})).toEqual({});
    expect(UpdateAppConfigBodySchema.parse({ compaction: {} })).toEqual({ compaction: {} });
    expect(UpdateAppConfigBodySchema.parse({ memory: {}, discord: { images: {} } })).toEqual({
      memory: {},
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
        payload: { compaction: { triggerRatio: 0.5 }, memory: { maxPinnedInjected: 2 } }
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "PUT", url: "/api/config", payload: { ocr: { enabled: false } } });
      expect(second.statusCode).toBe(200);
      expect(second.json().compaction).toMatchObject({ triggerRatio: 0.5, maxMessages: 150 });
      expect(second.json().memory).toMatchObject({ maxPinnedInjected: 2, dreamHourLocal: 5 });
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
      await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "aria", name: "Aria", displayName: "Aria" } });
      const url = "/api/waifus/aria";
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
      expect(dm.json().dm).toEqual({ allowDms: true, rateLimit: null, notifyWhenLimited: false, limitNotice: "slow down" });

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

  it("server PUT: contextWindows and compaction are optional overrides, null = inherit", async () => {
    const { app } = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      const created = await app.inject({ method: "PUT", url, payload: { paused: false } });
      expect(created.statusCode).toBe(200);
      expect(created.json().contextWindows).toEqual({});
      expect(created.json().compaction).toBeUndefined();

      const seeded = await app.inject({
        method: "PUT",
        url,
        payload: { contextWindows: { orchestrator: 11, waifu: 200 }, compaction: { maxMessages: 90, enabled: false } }
      });
      expect(seeded.json().contextWindows).toEqual({ orchestrator: 11, waifu: 200 });
      expect(seeded.json().compaction).toEqual({ maxMessages: 90, enabled: false });

      // An unrelated PUT keeps every override.
      const unrelated = await app.inject({ method: "PUT", url, payload: { memoryInjectionLimit: 7 } });
      expect(unrelated.json().contextWindows).toEqual({ orchestrator: 11, waifu: 200 });
      expect(unrelated.json().compaction).toEqual({ maxMessages: 90, enabled: false });

      // Sibling patches merge.
      const merged = await app.inject({
        method: "PUT",
        url,
        payload: { contextWindows: { stageManager: 40 }, compaction: { keepRecent: 12 } }
      });
      expect(merged.json().contextWindows).toEqual({ orchestrator: 11, waifu: 200, stageManager: 40 });
      expect(merged.json().compaction).toEqual({ maxMessages: 90, enabled: false, keepRecent: 12 });

      // null unsets one key; the others stay.
      const unset = await app.inject({
        method: "PUT",
        url,
        payload: { contextWindows: { waifu: null }, compaction: { enabled: null } }
      });
      expect(unset.json().contextWindows).toEqual({ orchestrator: 11, stageManager: 40 });
      expect(unset.json().compaction).toEqual({ maxMessages: 90, keepRecent: 12 });

      // Clearing everything leaves no stale empty override object behind.
      const cleared = await app.inject({
        method: "PUT",
        url,
        payload: {
          contextWindows: { orchestrator: null, stageManager: null },
          compaction: { maxMessages: null, keepRecent: null }
        }
      });
      expect(cleared.json().contextWindows).toEqual({});
      expect(cleared.json().compaction).toBeUndefined();

      expect((await app.inject({ method: "PUT", url, payload: { contextWindows: { waifu: 201 } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url, payload: { compaction: { triggerRatio: 0.99 } } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("server PUT reads a legacy file that stored all three windows", async () => {
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
      expect(read.json().contextWindows).toEqual({ orchestrator: 20, waifu: 50, stageManager: 80 });
      const patched = await app.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: { contextWindows: { waifu: 30 } } });
      expect(patched.json().contextWindows).toEqual({ orchestrator: 20, waifu: 30, stageManager: 80 });
    } finally {
      await app.close();
    }
  });
});
