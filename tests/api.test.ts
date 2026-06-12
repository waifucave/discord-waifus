import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

async function makeApp(extra: { llmFetch?: typeof fetch } = {}) {
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
    storage: new StorageService(root),
    ...(extra.llmFetch ? { llmGateway: { fetchImpl: extra.llmFetch } } : {})
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
    try {
      const current = await app.inject({ method: "GET", url: "/api/config" });
      await app.inject({
        method: "PUT",
        url: "/api/config",
        payload: {
          ...current.json(),
          frontend: {
            staticDir: path.join(root, "missing-old-package", "@starlight-ai", "discord-waifus", "dist-frontend")
          }
        }
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

  it("creates user memories as pinned and preserves pinned state across edits", async () => {
    const { app, root } = await makeApp();
    const now = new Date().toISOString();
    await writeFile(
      path.join(root, "user", "memories.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        updatedAt: now,
        memories: [
          {
            id: "seed-memory",
            waifuId: "yuki",
            guildId: "guild-1",
            content: "Seed memory.",
            kind: "fact",
            source: "stage_manager",
            pinned: false,
            strength: 3,
            entities: [],
            createdAt: now,
            updatedAt: now,
            status: "active"
          }
        ]
      }),
      "utf8"
    );

    try {
      const seeded = await app.inject({ method: "GET", url: "/api/memories" });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json().memories[0]).toMatchObject({
        id: "seed-memory",
        pinned: false,
        strength: 3
      });

      // A user-created memory is pinned by default with strength 5 and source "user".
      const created = await app.inject({
        method: "POST",
        url: "/api/memories",
        payload: {
          revision: 0,
          waifuId: "yuki",
          guildId: "guild-1",
          content: "Yuki knows Kevin is allergic to peanuts."
        }
      });
      expect(created.statusCode).toBe(201);
      const createdMemory = created.json().memories.at(-1);
      expect(createdMemory).toMatchObject({
        content: "Yuki knows Kevin is allergic to peanuts.",
        pinned: true,
        source: "user",
        strength: 5,
        kind: "fact"
      });
      expect(createdMemory.entities).toContain("Kevin");

      // Editing the content keeps the pinned state and re-derives entities.
      const edited = await app.inject({
        method: "PUT",
        url: `/api/memories/${createdMemory.id}`,
        payload: {
          revision: 1,
          content: "Riko owes Ali tacos since Thursday."
        }
      });
      expect(edited.statusCode).toBe(200);
      const editedMemory = edited.json().memories.find((memory: { id: string }) => memory.id === createdMemory.id);
      expect(editedMemory).toMatchObject({
        content: "Riko owes Ali tacos since Thursday.",
        pinned: true
      });
      expect(editedMemory.entities).toEqual(expect.arrayContaining(["Ali", "Thursday"]));
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
          prompt: "choose carefully",
          directiveCooldown: 5
        }
      });
      expect(config.statusCode).toBe(200);
      expect(config.json().revision).toBe(1);
      expect(config.json().prompt).toBe("choose carefully");
      expect(config.json().directiveCooldown).toBe(5);

      const trigger = await app.inject({ method: "POST", url: "/api/runtime/trigger/orchestrator" });
      expect(trigger.statusCode).toBe(200);
      expect(trigger.json().history.decisions).toHaveLength(1);

      const history = await app.inject({ method: "GET", url: "/api/orchestrator/history" });
      expect(history.statusCode).toBe(200);
      expect(history.json().decisions[0]).toMatchObject({
        action: "no_reply",
        respondingWaifus: [],
        retriggerAfterSeconds: 180,
        status: "completed",
        waifuMessageIds: [],
        responderOutcomes: []
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

const LLM_CHAT_OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

describe("LLM gateway mount (/api/llm)", () => {
  it("serves the gateway model registry through the mount", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/llm/v1/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as { models: Array<Record<string, unknown>> };
      expect(body.models).toHaveLength(100);
      expect(
        body.models.find((m) => m.providerId === "deepseek" && m.modelId === "deepseek-v4-pro")
      ).toEqual({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        family: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        company: "DeepSeek",
        wire: "openai-chat",
        contextTokens: 1000000,
        maxOutputTokens: 384000,
        streaming: true,
        tools: true,
        reasoning: true,
        jsonMode: true,
        jsonSchema: false,
        imageInput: false,
        deprecated: false,
        confidence: "verified"
      });

      const detail = await app.inject({
        method: "GET",
        url: "/api/llm/v1/models/openrouter/moonshotai/kimi-k2.6"
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        providerId: "openrouter",
        modelId: "moonshotai/kimi-k2.6",
        family: "kimi-k2-6",
        displayName: "Kimi K2.6",
        baseUrl: "https://openrouter.ai/api/v1"
      });
    } finally {
      await app.close();
    }
  });

  it("reflects StorageService credentials live in /v1/providers", async () => {
    const { app } = await makeApp();
    try {
      const before = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json() as {
        providers: Array<{ id: string; credentialConfigured: boolean }>;
      };
      expect(beforeBody.providers).toHaveLength(14);
      expect(beforeBody.providers.every((p) => p.credentialConfigured === false)).toBe(true);

      const put = await app.inject({
        method: "PUT",
        url: "/api/providers/deepseek/credentials",
        payload: { apiKey: "sk-live-key" }
      });
      expect(put.statusCode).toBe(200);

      const after = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
      const afterBody = after.json() as { providers: Array<Record<string, unknown>> };
      expect(afterBody.providers.find((p) => p.id === "deepseek")).toEqual({
        id: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        credentialEnv: "DEEPSEEK_API_KEY",
        wire: "openai-chat",
        credentialConfigured: true
      });
      expect(afterBody.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns the gateway 401 envelope for chat without a stored credential", async () => {
    const { app } = await makeApp();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/llm/v1/chat",
        payload: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }]
        }
      });
      expect(chat.statusCode).toBe(401);
      expect(chat.json()).toEqual({
        error: {
          kind: "auth",
          message: "no credential configured for provider deepseek",
          provider: "deepseek",
          retryable: false
        }
      });
    } finally {
      await app.close();
    }
  });

  it("flows a stored key onto the provider wire for chat", async () => {
    const llmFetch = vi.fn(
      async () => new Response(JSON.stringify(LLM_CHAT_OK_PAYLOAD), { status: 200 })
    );
    const { app } = await makeApp({ llmFetch: llmFetch as unknown as typeof fetch });
    try {
      await app.inject({
        method: "PUT",
        url: "/api/providers/deepseek/credentials",
        payload: { apiKey: "sk-live-key" }
      });
      const chat = await app.inject({
        method: "POST",
        url: "/api/llm/v1/chat",
        payload: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          params: { temperature: 0.7, "reasoning.enabled": true }
        }
      });
      expect(chat.statusCode).toBe(200);

      // P1b/P1c golden wire body, verbatim — proves the stored key reached the wire
      const [url, init] = llmFetch.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-live-key");
      expect(JSON.parse(init.body as string)).toEqual({
        model: "deepseek-v4-pro",
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }]
      });

      const body = chat.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        id: "cmpl_1",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: "hello" }],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 1 }
      });
      expect(body.warnings).toEqual([
        {
          code: "param_dropped",
          param: "temperature",
          ruleId: "thinking-drops-sampling",
          message: "temperature was dropped by constraint rule thinking-drops-sampling"
        },
        {
          code: "param_dropped",
          param: "topP",
          ruleId: "thinking-drops-sampling",
          message: "topP was dropped by constraint rule thinking-drops-sampling"
        }
      ]);
      expect(body.raw).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("answers /v1/validate with the pinned validation result", async () => {
    const { app } = await makeApp();
    try {
      const validate = await app.inject({
        method: "POST",
        url: "/api/llm/v1/validate",
        payload: { provider: "deepseek", model: "deepseek-v4-pro", params: { temperature: 99 } }
      });
      expect(validate.statusCode).toBe(200);
      expect(validate.json()).toEqual({
        ok: false,
        violations: [
          { param: "temperature", code: "out_of_range", message: "temperature must be in [0, 2]" }
        ],
        warnings: [
          { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" },
          { ruleId: "thinking-drops-sampling", param: "topP", code: "dropped" }
        ],
        effectiveParams: { "reasoning.enabled": true, "reasoning.effort": "high" }
      });
    } finally {
      await app.close();
    }
  });

  it("keeps gateway and app error envelopes separate", async () => {
    const { app } = await makeApp();
    try {
      const gateway404 = await app.inject({ method: "GET", url: "/api/llm/v1/nope" });
      expect(gateway404.statusCode).toBe(404);
      expect(gateway404.json()).toEqual({
        error: { kind: "invalid_request", message: "not found", retryable: false }
      });

      const method405 = await app.inject({
        method: "POST",
        url: "/api/llm/v1/providers",
        payload: {}
      });
      expect(method405.statusCode).toBe(405);
      expect(method405.headers.allow).toBe("GET");

      const app404 = await app.inject({ method: "GET", url: "/api/nope" });
      expect(app404.statusCode).toBe(404);
      expect(app404.json()).toEqual({
        error: "NotFound",
        message: "GET /api/nope was not found."
      });
    } finally {
      await app.close();
    }
  });
});

describe("Gateway registry proxies (/api/models, /api/providers)", () => {
  it("exposes both the legacy and gateway model lists on /api/models", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as {
        models: Array<{ modelId: string }>;
        gatewayModels: Array<{ providerId: string; modelId: string }>;
      };
      // legacy list byte-untouched: still 23 catalog models, including old-only ids
      expect(body.models).toHaveLength(23);
      expect(body.models.map((m) => m.modelId)).toContain("grok-4.3");
      expect(body.models.map((m) => m.modelId)).toContain("gpt-4o");
      // new list rides alongside
      expect(body.gatewayModels).toHaveLength(100);
      expect(
        body.gatewayModels.some(
          (m) => m.providerId === "openrouter" && m.modelId === "moonshotai/kimi-k2.6"
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("exposes both provider listings on /api/providers", async () => {
    const { app } = await makeApp();
    try {
      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      const body = providers.json() as {
        providers: Array<{ id: string; credentials: { configured: boolean } }>;
        gatewayProviders: Array<{ id: string; credentialConfigured: boolean }>;
      };
      expect(body.providers).toHaveLength(6);
      expect(body.providers.every((p) => p.credentials.configured === false)).toBe(true);
      expect(body.gatewayProviders).toHaveLength(14);
      expect(body.gatewayProviders.map((p) => p.id)).toContain("openrouter");
      expect(body.gatewayProviders.every((p) => p.credentialConfigured === false)).toBe(true);

      // the proxy's gateway listing reflects stored credentials live, same as /api/llm/v1/providers
      await app.inject({
        method: "PUT",
        url: "/api/providers/deepseek/credentials",
        payload: { apiKey: "sk-live-key" }
      });
      const after = await app.inject({ method: "GET", url: "/api/providers" });
      const afterBody = after.json() as typeof body;
      expect(afterBody.gatewayProviders.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(true);
      expect(afterBody.gatewayProviders.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
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

  it("POST /digest returns 409 when stage-manager has no model configured", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "digest-409", name: "Digest409", displayName: "Digest409" }
      });
      expect(create.statusCode).toBe(201);

      const digest = await app.inject({
        method: "POST",
        url: "/api/waifus/digest-409/digest"
      });
      expect(digest.statusCode).toBe(409);
      expect(digest.json().message).toBe("Stage-manager has no model configured.");
    } finally {
      await app.close();
    }
  });
});
