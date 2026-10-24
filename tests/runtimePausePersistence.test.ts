import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("B2: runtime pause persists across config saves and reloads", () => {
  it("pause/resume write runtime.paused to config.toml and keep in-memory state in sync", async () => {
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
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    // Mirrors startBackend's reload path, which re-reads config.runtime.paused from disk.
    const reload = vi.fn(async () => {
      runtime.paused = (await loadAppConfig(root)).runtime.paused;
    });
    const app = await createApiServer({
      dataRoot: root,
      runtime,
      storage: new StorageService(root),
      runtimeControl: { getCastRuntime: () => undefined, pause, resume, reload }
    });
    try {
      const paused = await app.inject({ method: "POST", url: "/api/runtime/pause" });
      expect(paused.statusCode).toBe(200);
      expect(pause).toHaveBeenCalledOnce();
      expect(runtime.paused).toBe(true);
      expect((await loadAppConfig(root)).runtime.paused).toBe(true);

      const saved = await app.inject({ method: "PUT", url: "/api/config", payload: { ocr: { enabled: false } } });
      expect(saved.statusCode).toBe(200);
      expect(reload).toHaveBeenCalled();
      expect(saved.json().runtime.paused).toBe(true);
      expect(runtime.paused).toBe(true);

      await app.inject({ method: "POST", url: "/api/runtime/reload" });
      expect(runtime.paused).toBe(true);

      const resumed = await app.inject({ method: "POST", url: "/api/runtime/resume" });
      expect(resumed.statusCode).toBe(200);
      expect(resume).toHaveBeenCalledOnce();
      expect(runtime.paused).toBe(false);
      expect((await loadAppConfig(root)).runtime.paused).toBe(false);
      await app.inject({ method: "POST", url: "/api/runtime/reload" });
      expect(runtime.paused).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("still pauses in memory and warns when config.toml cannot be persisted", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(path.join(root, "config.toml"), "this is = = not toml [[[\n");
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
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const warn = vi.fn();
    const app = await createApiServer({
      dataRoot: root,
      runtime,
      storage: new StorageService(root),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      runtimeControl: { getCastRuntime: () => undefined, pause, resume, reload: async () => undefined }
    });
    try {
      const paused = await app.inject({ method: "POST", url: "/api/runtime/pause" });
      expect(paused.statusCode).toBe(200);
      expect(pause).toHaveBeenCalledOnce();
      expect(runtime.paused).toBe(true);
      expect(paused.json().paused).toBe(true);
      expect(paused.json().warning).toMatch(/restart/);
      expect(warn).toHaveBeenCalled();

      const resumed = await app.inject({ method: "POST", url: "/api/runtime/resume" });
      expect(resumed.statusCode).toBe(200);
      expect(resume).toHaveBeenCalledOnce();
      expect(runtime.paused).toBe(false);
      expect(resumed.json().warning).toMatch(/restart/);
    } finally {
      await app.close();
    }
  });
});
