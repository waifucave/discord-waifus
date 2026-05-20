import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
    discord: {
      connected: false,
      orchestratorConnected: false,
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
    storage: new StorageService(root)
  });
  return { app, root };
}

describe("Backend API", () => {
  it("serves health, status, providers, and model catalog endpoints", async () => {
    const { app } = await makeApp();
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, service: "discord-waifus" });

      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.map((provider: { id: string }) => provider.id)).toContain("openai");

      const models = await app.inject({ method: "GET", url: "/api/models" });
      expect(models.statusCode).toBe(200);
      expect(models.json().models.map((model: { modelId: string }) => model.modelId)).toContain("grok-4.3");
    } finally {
      await app.close();
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
      expect(stale.json().latest.revision).toBe(1);
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

  it("persists agent config and records trigger histories", async () => {
    const { app } = await makeApp();
    try {
      const config = await app.inject({
        method: "PUT",
        url: "/api/orchestrator/config",
        payload: {
          revision: 0,
          enabled: true,
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          contextWindow: 20,
          prompt: "choose carefully"
        }
      });
      expect(config.statusCode).toBe(200);
      expect(config.json().revision).toBe(1);
      expect(config.json().prompt).toBe("choose carefully");

      const trigger = await app.inject({ method: "POST", url: "/api/runtime/trigger/orchestrator" });
      expect(trigger.statusCode).toBe(200);
      expect(trigger.json().history.decisions).toHaveLength(1);

      const history = await app.inject({ method: "GET", url: "/api/orchestrator/history" });
      expect(history.statusCode).toBe(200);
      expect(history.json().decisions[0]).toMatchObject({
        action: "no_reply",
        respondingWaifus: [],
        retriggerAfterSeconds: 180
      });
    } finally {
      await app.close();
    }
  });

  it("hot-reloads runtime after config and Discord bot updates", async () => {
    const reloadReasons: string[] = [];
    const runtimeControl = {
      getOrchestrator: () => undefined,
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
        orchestratorConnected: false,
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

  it("serves configured frontend static files", async () => {
    const { app, root } = await makeApp();
    try {
      const staticDir = path.join(root, "static");
      await mkdir(staticDir, { recursive: true });
      await writeFile(path.join(staticDir, "index.html"), "<div id=\"root\">ok</div>");
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
