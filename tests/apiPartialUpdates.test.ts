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

async function makeApp(logger?: Parameters<typeof createApiServer>[0]["logger"]) {
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
  return createApiServer({ dataRoot: root, runtime, storage: new StorageService(root), logger });
}

describe("B17: partial PUT bodies never re-materialize nested defaults", () => {
  it("a server detector override survives partial PUTs; null clears it", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      const seeded = await app.inject({ method: "PUT", url, payload: { detector: { target: "laya:english" } } });
      expect(seeded.statusCode).toBe(200);
      const paused = await app.inject({ method: "PUT", url, payload: { paused: true } });
      expect(paused.json()).toMatchObject({ paused: true, detector: { target: "laya:english" } });
      const cleared = await app.inject({ method: "PUT", url, payload: { detector: null } });
      expect(cleared.json().detector).toBeUndefined();
      expect(cleared.json().paused).toBe(true);
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

  it("waifu availability.bedTime patches keep the other bed time fields (a stray busy key is dropped, §21 S3)", async () => {
    const app = await makeApp();
    try {
      await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "ella", name: "Ella", displayName: "Ella" } });
      let waifu = (await app.inject({ method: "GET", url: "/api/waifus/ella" })).json();
      const seeded = await app.inject({
        method: "PUT",
        url: "/api/waifus/ella",
        payload: {
          revision: waifu.revision,
          availability: { bedTime: { enabled: false, start: "22:30", end: "06:15" }, busy: [{ start: "09:00", end: "12:00", reason: "class" }] }
        }
      });
      expect(seeded.statusCode).toBe(200);
      waifu = seeded.json();

      const patched = await app.inject({
        method: "PUT",
        url: "/api/waifus/ella",
        payload: { revision: waifu.revision, availability: { bedTime: { enabled: true } } }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().availability).toEqual({
        bedTime: { enabled: true, start: "22:30", end: "06:15" }
      });

      // Refinements still run on the merged result.
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/waifus/ella",
        payload: { revision: patched.json().revision, availability: { bedTime: { end: "22:30" } } }
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("channel PUT keeps omitted fields and accepts but ignores the removed enabled flag (spec 9.7)", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}/channels/${CHANNEL}`;
      const created = await app.inject({ method: "PUT", url, payload: { enabledWaifuIds: ["a"] } });
      expect(created.statusCode).toBe(200);
      expect(created.json().channels[CHANNEL]).toEqual({ channelId: CHANNEL, enabledWaifuIds: ["a"] });

      // `enabled` is accepted for one release but never stored and never silences the channel.
      const ignored = await app.inject({ method: "PUT", url, payload: { enabled: false } });
      expect(ignored.statusCode).toBe(200);
      expect(ignored.json().channels[CHANNEL]).toEqual({ channelId: CHANNEL, enabledWaifuIds: ["a"] });

      const renamed = await app.inject({ method: "PUT", url, payload: { name: "general", enabledWaifuIds: ["a", "b"] } });
      expect(renamed.json().channels[CHANNEL]).toEqual({
        channelId: CHANNEL,
        name: "general",
        enabledWaifuIds: ["a", "b"]
      });
    } finally {
      await app.close();
    }
  });

  it("logs once when a body still carries the removed enabled flag, and not when it does not", async () => {
    const warnings: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => void warnings.push(message),
      error: () => undefined
    };
    const app = await makeApp(logger);
    try {
      const url = `/api/servers/${GUILD}`;
      await app.inject({ method: "PUT", url, payload: { paused: false } });
      await app.inject({ method: "PUT", url: `${url}/channels/${CHANNEL}`, payload: { enabledWaifuIds: ["a"] } });
      expect(warnings).toEqual([]);
      await app.inject({ method: "PUT", url, payload: { enabled: true } });
      await app.inject({ method: "PUT", url: `${url}/channels/${CHANNEL}`, payload: { enabled: false } });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/Ignoring `enabled`/);
    } finally {
      await app.close();
    }
  });

  it("server PUT accepts but ignores the removed enabled flag, on the server and on wholesale channels", async () => {
    const app = await makeApp();
    try {
      const url = `/api/servers/${GUILD}`;
      const saved = await app.inject({
        method: "PUT",
        url,
        payload: {
          enabled: true,
          paused: true,
          channels: { [CHANNEL]: { channelId: CHANNEL, enabled: false, enabledWaifuIds: ["a"] } }
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).not.toHaveProperty("enabled");
      expect(saved.json().paused).toBe(true);
      expect(saved.json().channels[CHANNEL]).toEqual({ channelId: CHANNEL, enabledWaifuIds: ["a"] });
    } finally {
      await app.close();
    }
  });
});
