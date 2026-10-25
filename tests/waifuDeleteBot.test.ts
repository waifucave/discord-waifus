// Deleting a waifu removes her bot (token and application id) with her, unless another waifu still
// uses that bot, and reloads Discord so the bot goes offline.
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createLogger } from "../src/backend/logger.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function makeApp() {
  const root = await makeTempRoot("waifus-delete-bot-");
  roots.push(root);
  await ensureDataLayout(root);
  const reloads: string[] = [];
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    logger: createLogger(),
    runtimeControl: { reload: async (reason: string) => void reloads.push(reason) }
  } as Parameters<typeof createApiServer>[0]);
  apps.push(app);
  return { app, reloads };
}

async function createWaifu(app: Awaited<ReturnType<typeof makeApp>>["app"], id: string, botId?: string) {
  const created = await app.inject({ method: "POST", url: "/api/waifus", payload: { id, name: id, displayName: id, ...(botId ? { botId } : {}) } });
  expect(created.statusCode, created.body).toBeLessThan(300);
  return created.json() as { revision: number };
}

async function deleteWaifu(app: Awaited<ReturnType<typeof makeApp>>["app"], id: string) {
  const { revision } = (await app.inject({ method: "GET", url: `/api/waifus/${id}` })).json() as { revision: number };
  const deleted = await app.inject({ method: "DELETE", url: `/api/waifus/${id}`, payload: { revision } });
  expect(deleted.statusCode, deleted.body).toBe(204);
}

async function botIds(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  const bots = (await app.inject({ method: "GET", url: "/api/discord-bots" })).json() as { waifus: Array<{ id: string }> };
  return bots.waifus.map((bot) => bot.id);
}

describe("DELETE /api/waifus/:id", () => {
  it("removes her bot entry and reloads Discord", async () => {
    const { app, reloads } = await makeApp();
    await createWaifu(app, "vela");
    await createWaifu(app, "tova");
    for (const id of ["vela", "tova"]) {
      const linked = await app.inject({ method: "POST", url: `/api/waifus/${id}/link-bot`, payload: { applicationId: "1563868539683737693" } });
      expect(linked.statusCode, linked.body).toBe(200);
    }
    reloads.length = 0;
    await deleteWaifu(app, "vela");
    expect(await botIds(app)).toEqual(["tova"]);
    expect(reloads).toEqual(["discord-bots-updated"]);
  });

  it("keeps a bot another waifu still uses", async () => {
    const { app, reloads } = await makeApp();
    await createWaifu(app, "vela");
    const linked = await app.inject({ method: "POST", url: "/api/waifus/vela/link-bot", payload: {} });
    expect(linked.statusCode, linked.body).toBe(200);
    await createWaifu(app, "tova", "vela");
    reloads.length = 0;
    await deleteWaifu(app, "tova");
    expect(await botIds(app)).toEqual(["vela"]);
    expect(reloads).toEqual([]);
  });
});
