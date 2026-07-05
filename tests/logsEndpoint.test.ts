import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("GET /api/logs", () => {
  it("returns the NEWEST entries when limited (buffer is newest-first)", async () => {
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
      discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    // newest-first, like backend/logger.ts (unshift)
    const entries = Array.from({ length: 10 }, (_, i) => ({
      time: new Date(Date.now() - i * 1000).toISOString(),
      level: "info" as const,
      message: `entry-${9 - i}` // entry-9 is newest (index 0)
    }));
    const logger = { info() {}, warn() {}, error() {}, recent: () => entries };
    const app = await createApiServer({
      dataRoot: root,
      runtime,
      storage: new StorageService(root),
      logger: logger as never
    });
    try {
      const result = await app.inject({ method: "GET", url: "/api/logs?limit=3" });
      const body = JSON.parse(result.body) as { entries: Array<{ message: string }> };
      const names = body.entries.map((e) => e.message);
      expect(names).toContain("entry-9"); // the newest must be present
      expect(names).not.toContain("entry-0"); // the oldest must not
    } finally {
      await app.close();
    }
  });
});
