import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "323456789012345678";
const CHANNEL = "423456789012345678";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp() {
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
  return createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
}

describe("B17: partial PUT bodies never re-materialize nested defaults", () => {
  it("server tools and contextWindows merge with stored values", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      const seeded = await app.inject({
        method: "PUT",
        url,
        payload: {
          tools: { pickNextWaifu: false, shortTermMemory: false },
          contextWindows: { orchestrator: 11, waifu: 22, stageManager: 33 }
        }
      });
      expect(seeded.statusCode).toBe(200);

      const tools = await app.inject({ method: "PUT", url, payload: { tools: { pickNextWaifu: true } } });
      expect(tools.statusCode).toBe(200);
      expect(tools.json().tools).toEqual({ pickNextWaifu: true, shortTermMemory: false });

      const windows = await app.inject({ method: "PUT", url, payload: { contextWindows: { waifu: 30 } } });
      expect(windows.statusCode).toBe(200);
      expect(windows.json().contextWindows).toEqual({ orchestrator: 11, waifu: 30, stageManager: 33 });
      expect(windows.json().tools).toEqual({ pickNextWaifu: true, shortTermMemory: false });
    } finally {
      await app.close();
    }
  });

  it("server channels still replace wholesale", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      await app.inject({
        method: "PUT",
        url,
        payload: { channels: { [CHANNEL]: { channelId: CHANNEL, enabled: true, enabledWaifuIds: ["a"] } } }
      });
      const replaced = await app.inject({ method: "PUT", url, payload: { channels: {} } });
      expect(replaced.json().channels).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("waifu availability.sleep patches keep busy intervals and other sleep fields", async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "aria", name: "Aria", displayName: "Aria" } });
      let waifu = (await app.inject({ method: "GET", url: "/api/waifus/aria" })).json();
      const busy = [{ start: "09:00", end: "12:00", reason: "class" }];
      const seeded = await app.inject({
        method: "PUT",
        url: "/api/waifus/aria",
        payload: {
          revision: waifu.revision,
          availability: { sleep: { enabled: false, start: "22:30", end: "06:15" }, busy }
        }
      });
      expect(seeded.statusCode).toBe(200);
      waifu = seeded.json();

      const patched = await app.inject({
        method: "PUT",
        url: "/api/waifus/aria",
        payload: { revision: waifu.revision, availability: { sleep: { enabled: true } } }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().availability).toEqual({
        sleep: { enabled: true, start: "22:30", end: "06:15" },
        busy
      });

      // Refinements still run on the merged result.
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/waifus/aria",
        payload: { revision: patched.json().revision, availability: { sleep: { end: "22:30" } } }
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("agent promptSections patches keep sibling flags", async () => {
    const app = await makeApp();
    try {
      const url = "/api/orchestrator/config";
      const seeded = await app.inject({
        method: "PUT",
        url,
        payload: { promptSections: { pausePlanning: false, messageStructure: false } }
      });
      expect(seeded.statusCode).toBe(200);
      const patched = await app.inject({ method: "PUT", url, payload: { promptSections: { pausePlanning: true } } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().promptSections).toEqual({ pausePlanning: true, messageStructure: false });
    } finally {
      await app.close();
    }
  });

  it("channel PUT omitting enabled keeps the stored value", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}/channels/${CHANNEL}`;
      const created = await app.inject({ method: "PUT", url, payload: { enabledWaifuIds: ["a"] } });
      expect(created.statusCode).toBe(200);
      // A brand-new channel written through this route is enabled unless told otherwise.
      expect(created.json().channels[CHANNEL].enabled).toBe(true);

      const disabled = await app.inject({ method: "PUT", url, payload: { enabled: false } });
      expect(disabled.json().channels[CHANNEL]).toMatchObject({ enabled: false, enabledWaifuIds: ["a"] });

      const renamed = await app.inject({ method: "PUT", url, payload: { name: "general", enabledWaifuIds: ["a", "b"] } });
      expect(renamed.json().channels[CHANNEL]).toMatchObject({
        enabled: false,
        name: "general",
        enabledWaifuIds: ["a", "b"]
      });
    } finally {
      await app.close();
    }
  });
});
