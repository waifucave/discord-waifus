import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApiServer, resolveStaticDir, type ApiServerOptions } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { decisionModelCatalog } from "../src/life/detector/catalog.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp(extra: { castRuntime?: unknown; runtimeControl?: ApiServerOptions["runtimeControl"] } = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: {
      connected: false,
      houseConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: {
      active: 0,
      configuredGuilds: 0
    }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    ...(extra.runtimeControl ? { runtimeControl: extra.runtimeControl } : {}),
    ...(extra.castRuntime ? { castRuntime: extra.castRuntime as never } : {})
  });
  return { app, root };
}

describe("Backend API", () => {
  it("persists idle-update settings without reloading or interrupting the runtime", async () => {
    const reload = vi.fn(async () => undefined);
    const { app } = await makeApp({ runtimeControl: { getCastRuntime: () => undefined,
      pause: async () => undefined, resume: async () => undefined, reload } });
    try {
      const current = (await app.inject({ method: "GET", url: "/api/config" })).json();
      const saved = await app.inject({ method: "PUT", url: "/api/config", payload: { updates: { enabled: true, idleMinutes: 7 } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().updates).toEqual({ enabled: true, idleMinutes: 7, checkIntervalMinutes: 60 });
      expect(saved.json().runtime).toEqual(current.runtime);
      expect(reload).not.toHaveBeenCalled();
      const unrelated = await app.inject({ method: "PUT", url: "/api/config", payload: { ocr: { enabled: false } } });
      expect(unrelated.json().updates).toEqual(saved.json().updates);
      expect(reload).toHaveBeenCalledExactlyOnceWith("config-updated");
    } finally { await app.close(); }
  });
  it("persists the opt-in GuildMembers intent and member-list refresh interval, defaulting to off and 24 h", async () => {
    const { app } = await makeApp();
    try {
      const current = (await app.inject({ method: "GET", url: "/api/config" })).json();
      expect(current.discord).toMatchObject({ guildMembersIntent: false, memberListRefreshHours: 24 });
      const saved = await app.inject({ method: "PUT", url: "/api/config", payload: { discord: { guildMembersIntent: true, memberListRefreshHours: 6 } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().discord).toMatchObject({ guildMembersIntent: true, memberListRefreshHours: 6 });
      const other = await app.inject({ method: "PUT", url: "/api/config", payload: { discord: { memberListRefreshHours: 0 } } });
      expect(other.json().discord).toMatchObject({ guildMembersIntent: true, memberListRefreshHours: 0 });
      const bad = await app.inject({ method: "PUT", url: "/api/config", payload: { discord: { memberListRefreshHours: 500 } } });
      expect(bad.statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it("persists a server detector override, keeps it on unrelated server updates, and null removes it", async () => {
    const { app } = await makeApp();
    try {
      const selected = await app.inject({ method: "PUT", url: "/api/servers/100000000000000001", payload: { detector: { target: "openrouter:typesafe/jev-1.13" } } });
      expect(selected.statusCode).toBe(200);
      expect(selected.json().detector).toEqual({ target: "openrouter:typesafe/jev-1.13" });
      const updated = await app.inject({ method: "PUT", url: "/api/servers/100000000000000001", payload: { name: "renamed" } });
      expect(updated.json()).toMatchObject({ detector: { target: "openrouter:typesafe/jev-1.13" } });
      expect((await app.inject({ method: "PUT", url: "/api/servers/100000000000000001", payload: { detector: { target: "openrouter:respan/span-01" } } })).statusCode).toBe(400);
      const off = await app.inject({ method: "PUT", url: "/api/servers/100000000000000001", payload: { detector: { target: "" } } });
      expect(off.json().detector).toEqual({ target: "" });
      const inherited = await app.inject({ method: "PUT", url: "/api/servers/100000000000000001", payload: { detector: null } });
      expect(inherited.json().detector).toBeUndefined();
    } finally { await app.close(); }
  });
  it("lists decision models and credential presence without exposing credentials", async () => {
    vi.spyOn(decisionModelCatalog, "list").mockResolvedValue({ unavailable: false, models: [{ target: "openai:gpt-6-luna", label: "OpenAI Decisions", provider: "openai", local: false }] });
    const { app } = await makeApp();
    try {
      await app.inject({ method: "PUT", url: "/api/providers/openai/credentials", payload: { apiKey: "fixture-secret" } });
      const response = await app.inject({ method: "GET", url: "/api/detector/models" });
      expect(response.statusCode).toBe(200);
      expect(response.json().models[0]).toMatchObject({ configured: true, target: "openai:gpt-6-luna" });
      expect(response.body).not.toContain("fixture-secret");
    } finally { await app.close(); }
  });
  it("serves health, status, and provider credential-status endpoints; the retired routes are gone", async () => {
    const { app } = await makeApp();
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, service: "discord-waifus" });

      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.map((provider: { id: string }) => provider.id)).toContain("openai");

      for (const url of ["/api/llm/v1/models", "/api/orchestrator/config", "/api/memories", "/api/orchestrator/one-shot/models"]) {
        expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("serves the SPA index.html even when started from a non-package working directory", async () => {
    // Regression: the default frontend dir must resolve relative to the installed
    // package, not process.cwd(). A globally/locally installed `waifus start` runs
    // from an arbitrary directory, so a cwd-relative path leaves the dashboard 404ing
    // while the API keeps working.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const distFrontend = path.join(repoRoot, "dist-frontend");
    const indexHtml = path.join(distFrontend, "index.html");

    // dist-frontend is a gitignored build artifact; on an unbuilt checkout, drop a
    // placeholder so this test exercises the real default path either way, then remove it.
    let createdIndex = false;
    let createdDir = false;
    if (!existsSync(indexHtml)) {
      if (!existsSync(distFrontend)) {
        mkdirSync(distFrontend, { recursive: true });
        createdDir = true;
      }
      writeFileSync(indexHtml, "<!doctype html><title>placeholder</title>");
      createdIndex = true;
    }

    const { app } = await makeApp();
    const elsewhere = await makeTempRoot();
    roots.push(elsewhere);
    const originalCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body.toLowerCase()).toContain("<!doctype html>");
    } finally {
      process.chdir(originalCwd);
      await app.close();
      if (createdIndex) rmSync(indexHtml, { force: true });
      if (createdDir) rmSync(distFrontend, { recursive: true, force: true });
    }
  });

  it("falls back to the bundled SPA when configured frontend.staticDir is stale", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const distFrontend = path.join(repoRoot, "dist-frontend");
    const indexHtml = path.join(distFrontend, "index.html");

    let createdIndex = false;
    let createdDir = false;
    if (!existsSync(indexHtml)) {
      if (!existsSync(distFrontend)) {
        mkdirSync(distFrontend, { recursive: true });
        createdDir = true;
      }
      writeFileSync(indexHtml, "<!doctype html><title>placeholder</title>");
      createdIndex = true;
    }

    const { app, root } = await makeApp();
    const staleStaticDir = path.join(
      root,
      "missing-old-package",
      "@starlight-ai",
      "discord-waifus",
      "dist-frontend"
    );
    try {
      const current = await app.inject({ method: "GET", url: "/api/config" });
      await app.inject({
        method: "PUT",
        url: "/api/config",
        payload: {
          ...current.json(),
          frontend: {
            staticDir: staleStaticDir
          }
        }
      });

      await expect(resolveStaticDir(staleStaticDir)).resolves.toEqual({
        path: distFrontend,
        source: "bundled"
      });

      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body.toLowerCase()).toContain("<!doctype html>");
    } finally {
      await app.close();
      if (createdIndex) rmSync(indexHtml, { force: true });
      if (createdDir) rmSync(distFrontend, { recursive: true, force: true });
    }
  });

  it("redacts provider credentials and rejects stale credential writes", async () => {
    const { app } = await makeApp();
    try {
      const first = await app.inject({
        method: "PUT",
        url: "/api/providers/openai/credentials",
        payload: {
          revision: 0,
          apiKey: "sk-test_12345678901234567890"
        }
      });
      expect(first.statusCode).toBe(200);
      expect(JSON.stringify(first.json())).not.toContain("sk-test");
      expect(first.json().credentials.keyHint).toContain("7890");

      const stale = await app.inject({
        method: "PUT",
        url: "/api/providers/openai/credentials",
        payload: {
          revision: 0,
          apiKey: "sk-test_stale123456789012345678"
        }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({
        error: "Conflict",
        message: "Record has changed since it was read.",
        latest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          revision: 1,
          updatedAt: expect.any(String)
        }
      });
    } finally {
      await app.close();
    }
  });

  it("creates waifus and requires optimistic concurrency for overwrites", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: {
          id: "yuki",
          name: "Yuki",
          displayName: "Yuki"
        }
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().revision).toBe(0);

      const noRevision = await app.inject({
        method: "PUT",
        url: "/api/waifus/yuki",
        payload: {
          persona: "kind"
        }
      });
      expect(noRevision.statusCode).toBe(428);

      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/yuki",
        payload: {
          revision: 0,
          persona: "kind"
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().revision).toBe(1);
      expect(update.json().persona).toBe("kind");
    } finally {
      await app.close();
    }
  });

  // Gateway-era `params` and agent configs left with Living cast L1; model writes are covered in
  // tests/modelsApi.test.ts.
  describe("logs and docs", () => {
    it("serves recent logs and the assistant docs KB", async () => {
      const { app } = await makeApp();
      try {
        const logs = await app.inject({ method: "GET", url: "/api/logs?limit=5" });
        expect(logs.statusCode).toBe(200);
        expect(Array.isArray(logs.json().entries)).toBe(true);

        const index = await app.inject({ method: "GET", url: "/api/docs" });
        expect(index.statusCode).toBe(200);
        const slugs = index.json().docs.map((d: { slug: string }) => d.slug);
        expect(slugs).toContain("getting-started");
        expect(slugs).toContain("api");

        const doc = await app.inject({ method: "GET", url: "/api/docs/waifus" });
        expect(doc.statusCode).toBe(200);
        expect(doc.json().content).toContain("persona");

        const missing = await app.inject({ method: "GET", url: "/api/docs/nope" });
        expect(missing.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  // P5 Task 4 review fix: zod v4 `.partial()` does NOT keep fields-with-`.default()` absent —
  // parsing a body that omits such a field fills in its default, which then flows into the
  // `{...current, ...patch}` merge as if the client had sent it, silently overwriting stored
  // data. AgentConfigBodySchema/UpdateWaifuBodySchema must re-declare every defaulted field as
  // truly optional-without-default so "absent from the PUT body" means "leave it alone."
  describe("PATCH-true body schemas: PUT must not manufacture schema defaults into the merge", () => {
    it("PUT waifu with only {revision, displayName} leaves the model and custom instructions untouched and ignores retired fields", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "patch-true", name: "PatchTrue", displayName: "PatchTrue" }
        });

        // Spec 8.6: the layout editor is gone; a stale client may still send one. It is ignored.
        const staleLayout = {
          top: [{ kind: "block", blockId: "identity", enabled: false }],
          mid: [],
          trailing: []
        };
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/waifus/patch-true",
          payload: {
            revision: 0,
            model: { providerId: "deepseek", modelId: "deepseek-flash" },
            customInstructions: "Speak softly.",
            // Retired by Living cast L1: accepted from stale clients, never stored.
            contextWindow: 77,
            tools: { toolUse: false },
            params: { temperature: 0.2 },
            promptLayout: staleLayout,
            // Retired 2026-10-25: the reply style setting.
            verbosity: "chatty"
          }
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json().model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
        for (const retired of ["contextWindow", "tools", "params", "promptLayout", "verbosity"]) expect(seeded.json()).not.toHaveProperty(retired);

        const renamed = await app.inject({
          method: "PUT",
          url: "/api/waifus/patch-true",
          payload: { revision: 1, displayName: "New Display Name" }
        });
        expect(renamed.statusCode).toBe(200);
        expect(renamed.json().displayName).toBe("New Display Name");
        expect(renamed.json().model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
        expect(renamed.json().customInstructions).toBe("Speak softly.");
        expect(renamed.json()).not.toHaveProperty("promptLayout");

        const get = await app.inject({ method: "GET", url: "/api/waifus/patch-true" });
        expect(get.statusCode).toBe(200);
        expect(get.json().model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
        expect(get.json()).not.toHaveProperty("promptLayout");
      } finally {
        await app.close();
      }
    });

    it("a partial waifu PUT keeps her daily budget, wake-on-name and sleep notice (review I-A)", async () => {
      const { app } = await makeApp();
      try {
        const created = await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "laya", name: "Laya", displayName: "Laya" } });
        const set = await app.inject({
          method: "PUT",
          url: "/api/waifus/laya",
          payload: { revision: created.json().revision, life: { dailyBudgetUsd: 5 }, wakeOnName: false, dm: { sleepNotice: "asleep, back at 8" } }
        });
        expect(set.statusCode, set.body).toBe(200);
        const toggled = await app.inject({ method: "PUT", url: "/api/waifus/laya", payload: { revision: set.json().revision, enabled: false } });
        expect(toggled.statusCode, toggled.body).toBe(200);
        expect(toggled.json()).toMatchObject({ enabled: false, wakeOnName: false, life: { dailyBudgetUsd: 5 }, dm: { sleepNotice: "asleep, back at 8" } });
        // null is a real value: no budget.
        const cleared = await app.inject({ method: "PUT", url: "/api/waifus/laya", payload: { revision: toggled.json().revision, life: { dailyBudgetUsd: null } } });
        expect(cleared.json()).toMatchObject({ life: { dailyBudgetUsd: null }, wakeOnName: false });
        expect((await app.inject({ method: "PUT", url: "/api/waifus/laya", payload: { revision: cleared.json().revision, life: { dailyBudgetUsd: -1 } } })).statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("POST /api/waifus with a minimal body still applies schema defaults (create semantics unaffected)", async () => {
      const { app } = await makeApp();
      try {
        const create = await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { name: "Minimal", displayName: "Minimal" }
        });
        expect(create.statusCode).toBe(201);
        const created = create.json();
        expect(created.enabled).toBe(true);
        expect(created.persona).toBe("");
        expect(created.customInstructions).toBe("");
        expect(created).not.toHaveProperty("model");
        expect(created).not.toHaveProperty("promptLayout");
      } finally {
        await app.close();
      }
    });

    it("retired server fields (Living cast §11.2) are ignored on PUT and never returned", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({ method: "PUT", url: "/api/servers/100000000000000002", payload: { name: "Modes", enabled: true } });
        const saved = await app.inject({
          method: "PUT",
          url: "/api/servers/100000000000000002",
          payload: { stageManagerEnabled: false, memoryInjectionLimit: 30, contextWindows: { waifu: 50 }, tools: { shortTermMemory: true } }
        });
        expect(saved.statusCode).toBe(200);
        const server = saved.json() as Record<string, unknown>;
        for (const key of ["stageManagerEnabled", "memoryInjectionLimit", "contextWindows", "tools", "compaction"]) expect(server).not.toHaveProperty(key);
        expect(server).not.toHaveProperty("detector");
      } finally {
        await app.close();
      }
    });

    it("DELETE /api/servers/:guildId says decision history is removed too, and removes it (I1)", async () => {
      const { app, root } = await makeApp();
      try {
        const guildId = "100000000000000101";
        await app.inject({ method: "PUT", url: `/api/servers/${guildId}`, payload: { paused: false } });
        await writeFile(path.join(root, "user", "servers", guildId, "orchestrator-history.json"), "{}");
        const res = await app.inject({ method: "DELETE", url: `/api/servers/${guildId}` });
        expect(res.statusCode).toBe(200);
        expect(res.json().message).toMatch(/decision history/);
        expect(await readFile(path.join(root, "user", "servers", guildId, "orchestrator-history.json"), "utf8").catch(() => "gone")).toBe("gone");
      } finally {
        await app.close();
      }
    });

    it("per-server paused round-trips, defaults false, and survives unrelated PUTs", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({ method: "PUT", url: "/api/servers/100000000000000003", payload: {} });
        let server = JSON.parse((await app.inject({ method: "GET", url: "/api/servers/100000000000000003" })).body) as Record<string, unknown>;
        expect(server.paused).toBe(false);
        await app.inject({ method: "PUT", url: "/api/servers/100000000000000003", payload: { revision: server.revision, paused: true } });
        server = JSON.parse((await app.inject({ method: "GET", url: "/api/servers/100000000000000003" })).body) as Record<string, unknown>;
        expect(server.paused).toBe(true);
        await app.inject({ method: "PUT", url: "/api/servers/100000000000000003", payload: { revision: server.revision, orchestratorMode: "deterministic" } });
        server = JSON.parse((await app.inject({ method: "GET", url: "/api/servers/100000000000000003" })).body) as Record<string, unknown>;
        expect(server.paused).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("PUT waifu with botId:null unlinks the bot", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "unlink-me", name: "U", displayName: "U", persona: "x" } });
        let waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/unlink-me" })).body) as { revision: number };
        await app.inject({ method: "PUT", url: "/api/waifus/unlink-me", payload: { revision: waifu.revision, botId: "some-bot" } });
        waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/unlink-me" })).body) as { revision: number; botId?: string };
        expect((waifu as { botId?: string }).botId).toBe("some-bot");
        await app.inject({ method: "PUT", url: "/api/waifus/unlink-me", payload: { revision: waifu.revision, botId: null } });
        const after = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/unlink-me" })).body) as { botId?: string };
        expect(after.botId).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("GET /api/servers/:guildId returns one server (Rooms guild screen depends on it)", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "PUT",
          url: "/api/servers/100000000000000004",
          payload: { name: "Single", enabled: true }
        });
        const single = await app.inject({ method: "GET", url: "/api/servers/100000000000000004" });
        expect(single.statusCode).toBe(200);
        expect(JSON.parse(single.body).guildId).toBe("100000000000000004");
        const missing = await app.inject({ method: "GET", url: "/api/servers/100000000000000099" });
        expect(missing.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("a partial server PUT keeps the stored detector override and channels (no manufactured defaults)", async () => {
      const { app } = await makeApp();
      try {
        const guildId = "100000000000000005";
        const seeded = await app.inject({
          method: "PUT",
          url: `/api/servers/${guildId}`,
          payload: { revision: 0, name: "Test Guild", detector: { target: "openai:gpt-6-luna" }, channels: {} }
        });
        expect(seeded.statusCode).toBe(200);
        const patched = await app.inject({ method: "PUT", url: `/api/servers/${guildId}`, payload: { revision: 1, name: "Renamed" } });
        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toMatchObject({ name: "Renamed", detector: { target: "openai:gpt-6-luna" } });
      } finally {
        await app.close();
      }
    });
  });

  it("deletes waifus using a revision in the JSON body", async () => {
    const { app } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: {
          id: "delete-test",
          name: "Delete Test",
          displayName: "Delete Test"
        }
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/waifus/delete-test",
        payload: {
          revision: 0
        }
      });
      expect(deleted.statusCode).toBe(204);

      const missing = await app.inject({ method: "GET", url: "/api/waifus/delete-test" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("hot-reloads runtime after config and Discord bot updates", async () => {
    const reloadReasons: string[] = [];
    const runtimeControl = {
      getCastRuntime: () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
      reload: async (reason: string) => {
        reloadReasons.push(reason);
      }
    };
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "0.1.0",
      port: 3888,
      dataRoot: root,
      mode: "test",
      paused: false,
      discord: {
        connected: false,
        houseConnected: false,
        waifuBotCount: 0,
        warnings: []
      },
      queues: {
        active: 0,
        configuredGuilds: 0
      }
    });
    const hotApp = await createApiServer({
      dataRoot: root,
      runtime,
      storage: new StorageService(root),
      runtimeControl
    });
    try {
      const config = await hotApp.inject({ method: "GET", url: "/api/config" });
      const saveConfig = await hotApp.inject({
        method: "PUT",
        url: "/api/config",
        payload: {
          ...config.json(),
          runtime: { autoConnectDiscord: true, paused: false }
        }
      });
      expect(saveConfig.statusCode).toBe(200);

      const saveBots = await hotApp.inject({
        method: "PUT",
        url: "/api/discord-bots",
        payload: {
          revision: 0,
          orchestrator: {
            id: "orchestrator",
            displayName: "Orchestrator",
            applicationId: "123",
            token: "bot-token",
            enabled: true
          },
          waifus: []
        }
      });
      expect(saveBots.statusCode).toBe(200);
      expect(JSON.stringify(saveBots.json())).not.toContain("bot-token");
      expect(reloadReasons).toEqual(["config-updated", "discord-bots-updated"]);
    } finally {
      await hotApp.close();
    }
  });

  it("stores waifu image assets", async () => {
    const { app, root } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: {
          id: "asset-test",
          name: "Asset Test",
          displayName: "Asset Test"
        }
      });
      const upload = await app.inject({
        method: "POST",
        url: "/api/waifus/asset-test/assets/pfp",
        headers: { "content-type": "image/png" },
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47])
      });
      expect(upload.statusCode).toBe(201);
      expect(upload.json().relativePath).toBe("user/waifus/asset-test/pfp.png");
      const saved = await readFile(path.join(root, "user", "waifus", "asset-test", "pfp.png"));
      expect([...saved]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await app.close();
    }
  });

  it("clears OCR cache and temporary OCR files", async () => {
    const { app, root } = await makeApp();
    const cached = path.join(root, "app", "cache", "ocr", "results", "cached.json");
    const temp = path.join(root, "app", "tmp", "ocr", "download.png");
    try {
      await mkdir(path.dirname(cached), { recursive: true });
      await mkdir(path.dirname(temp), { recursive: true });
      await writeFile(cached, "{}");
      await writeFile(temp, "image");

      const response = await app.inject({ method: "POST", url: "/api/cache/ocr/clear" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ accepted: true });
      await expect(readFile(cached, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(temp, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it("serves configured frontend static files", async () => {
    const { app, root } = await makeApp();
    try {
      const staticDir = path.join(root, "static");
      await mkdir(staticDir, { recursive: true });
      await writeFile(path.join(staticDir, "index.html"), "<div id=\"root\">ok</div>");
      await expect(resolveStaticDir(staticDir)).resolves.toEqual({
        path: staticDir,
        source: "custom"
      });
      const current = await app.inject({ method: "GET", url: "/api/config" });
      await app.inject({
        method: "PUT",
        url: "/api/config",
        payload: {
          ...current.json(),
          frontend: { staticDir }
        }
      });
      const rootResponse = await app.inject({ method: "GET", url: "/" });
      expect(rootResponse.statusCode).toBe(200);
      expect(rootResponse.headers["content-type"]).toContain("text/html");
      expect(rootResponse.body).toContain("root");
    } finally {
      await app.close();
    }
  });
});

// Provider ids are any LLM provider the installed winter catalog knows (Living cast §9.2); an
// unknown id is refused at write time. Model writes are covered in tests/modelsApi.test.ts.
describe("Provider ids and credential writes", () => {
  it("stores credentials for a provider id outside the legacy 6-id enum and enforces optimistic concurrency for it", async () => {
    const { app } = await makeApp();
    try {
      const first = await app.inject({
        method: "PUT",
        url: "/api/providers/openrouter/credentials",
        payload: {
          revision: 0,
          apiKey: "or-test_12345678901234567890"
        }
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().providerId).toBe("openrouter");
      expect(first.json().credentials.configured).toBe(true);
      expect(JSON.stringify(first.json())).not.toContain("or-test_12345678901234567890");

      // A second write with the now-stale revision proves the first write actually persisted.
      const stale = await app.inject({
        method: "PUT",
        url: "/api/providers/openrouter/credentials",
        payload: {
          revision: 0,
          apiKey: "or-test_09876543210987654321"
        }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({
        error: "Conflict",
        message: "Record has changed since it was read.",
        latest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          revision: 1,
          updatedAt: expect.any(String)
        }
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a credential write for a provider id the winter catalog doesn't know", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/providers/notaprovider/credentials",
        payload: {
          revision: 0,
          apiKey: "np-test_12345678901234567890"
        }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({ error: "unknown_provider", providerId: "notaprovider" });
    } finally {
      await app.close();
    }
  });

});

// Write-contract hardening: a retired personaDigest sent on POST /api/waifus is stripped as an
// unknown key, never stored; the DiscordBots write path requires `enabled` explicitly per bot.
describe("Write-contract hardening", () => {
  it("POST /api/waifus with a personaDigest in the body strips it rather than storing it", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: {
          id: "digest-strip",
          name: "DigestStrip",
          displayName: "DigestStrip",
          personaDigest: { voice: "sneaky", role: "attacker", personaHash: "deadbeef" }
        }
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().personaDigest).toBeUndefined();

      const get = await app.inject({ method: "GET", url: "/api/waifus/digest-strip" });
      expect(get.json().personaDigest).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("PUT /api/discord-bots with a bot body missing 'enabled' is rejected (400)", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/discord-bots",
        payload: {
          revision: 0,
          orchestrator: {
            id: "orchestrator",
            displayName: "Orchestrator",
            applicationId: "123",
            token: "bot-token"
          }
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/discord-bots with the existing client shape (enabled present) succeeds (200)", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/discord-bots",
        payload: {
          revision: 0,
          orchestrator: {
            id: "orchestrator",
            displayName: "Orchestrator",
            applicationId: "123",
            token: "bot-token",
            enabled: true
          }
        }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

const LLM_CHAT_OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

describe("/api/providers over the winter catalog (Living cast §9.2)", () => {
  it("shows configured + keyHint for an openrouter credential on /api/providers (previously unlisted under the legacy 6-id enum)", async () => {
    const { app } = await makeApp();
    try {
      const put = await app.inject({
        method: "PUT",
        url: "/api/providers/openrouter/credentials",
        payload: { revision: 0, apiKey: "or-test_dummy1234567890" }
      });
      expect(put.statusCode).toBe(200);

      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      const entry = (
        providers.json().providers as Array<{
          id: string;
          credentials: { configured: boolean; keyHint?: string };
        }>
      ).find((p) => p.id === "openrouter");
      expect(entry?.credentials.configured).toBe(true);
      expect(entry?.credentials.keyHint).toBe("****7890");
    } finally {
      await app.close();
    }
  });

  it("PUT waifu with persona change succeeds (graceful skip when stage-manager unconfigured)", async () => {
    const { app } = await makeApp();
    try {
      // Create a waifu first
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "digest-test", name: "DigestTest", displayName: "DigestTest" }
      });
      expect(create.statusCode).toBe(201);

      // PUT with a new persona — stage-manager is unconfigured so digest generation is skipped
      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/digest-test",
        payload: { revision: 0, persona: "A helpful and funny character." }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().persona).toBe("A helpful and funny character.");
      // personaDigest should remain absent (no stage-manager model)
      expect(update.json().personaDigest).toBeUndefined();
    } finally {
      await app.close();
    }
  });

});
