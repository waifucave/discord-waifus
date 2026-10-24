import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { resolveDataPath, userDataPath } from "../src/config/paths.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "123456789012345678";
const CHANNEL = "223456789012345678";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
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
  const app = await createApiServer({ dataRoot: root, runtime, storage });
  return { app, root, storage };
}

function rawRequest(port: number, method: string, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: rawPath, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function seedUserData(root: string): Promise<string> {
  const waifuFile = userDataPath(root, "waifus", "keep-me", "waifu.json");
  await mkdir(path.dirname(waifuFile), { recursive: true });
  await writeFile(waifuFile, "{}\n");
  return waifuFile;
}

describe("B1: request ids cannot escape the data root", () => {
  it("DELETE /api/servers/%2E%2E is rejected and never removes user data", async () => {
    const { app, root } = await makeApp();
    try {
      const sentinel = await seedUserData(root);
      // app.inject normalizes dot segments away, so send the raw path over a real socket the
      // way `curl --path-as-is` does; Fastify then decodes %2E%2E to a literal "..".
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      for (const encoded of ["%2E%2E", "..", "%2E"]) {
        const status = await rawRequest(port, "DELETE", `/api/servers/${encoded}`);
        expect(status, encoded).toBe(400);
      }
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(userDataPath(root))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("guild and channel route params must be Discord snowflakes", async () => {
    const { app } = await makeApp();
    try {
      expect((await app.inject({ method: "PUT", url: "/api/servers/not-a-guild", payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/servers/12345" })).statusCode).toBe(400);
      expect((await app.inject({
        method: "PUT",
        url: `/api/servers/${GUILD}/channels/general`,
        payload: { enabled: true }
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: "/api/people/not-a-user/forget",
        payload: { confirm: true }
      })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: {} })).statusCode).toBe(200);
      expect((await app.inject({
        method: "PUT",
        url: `/api/servers/${GUILD}/channels/${CHANNEL}`,
        payload: { enabled: true }
      })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("slug waifu ids stay valid while dot-only ids are rejected", async () => {
    const { app } = await makeApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "aria.v2", name: "Aria", displayName: "Aria" }
      });
      expect(created.statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: "/api/waifus/aria.v2" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/waifus/..." })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "..", name: "Dots", displayName: "Dots" }
      })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/servers/:guildId waits for the server resource lock", async () => {
    const { app, root, storage } = await makeApp();
    try {
      expect((await app.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: {} })).statusCode).toBe(200);
      const serverDir = userDataPath(root, "servers", GUILD);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let lockAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
      const holder = storage.withLocks([`server:${GUILD}`], async () => {
        lockAcquired();
        await held;
        expect(existsSync(serverDir)).toBe(true);
      });
      await acquired;
      const deletion = app.inject({ method: "DELETE", url: `/api/servers/${GUILD}` });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(serverDir)).toBe(true);
      release();
      await holder;
      expect((await deletion).statusCode).toBe(200);
      expect(existsSync(serverDir)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("B1: resolveDataPath containment", () => {
  it("throws when segments resolve outside the data root", () => {
    const root = path.resolve("/tmp/dc-waifus-root");
    expect(() => resolveDataPath(root, "user", "servers", "..", "..", "..")).toThrow();
    expect(() => resolveDataPath(root, "..", "elsewhere")).toThrow();
    expect(() => resolveDataPath(root, "/etc/passwd")).not.toThrow();
    expect(resolveDataPath(root, "/etc/passwd")).toBe(path.join(root, "etc", "passwd"));
    expect(resolveDataPath(root, "user", "servers", "x", "..", "y")).toBe(path.join(root, "user", "servers", "y"));
    expect(resolveDataPath(root)).toBe(root);
  });
});
