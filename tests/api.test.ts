import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { defaultWaifuPromptLayout } from "../src/shared/schemas/domain.js";
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
  it("serves health, status, and provider credential-status endpoints; /api/models is gone (Gateway P6 Task 3)", async () => {
    const { app } = await makeApp();
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, service: "discord-waifus" });

      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.map((provider: { id: string }) => provider.id)).toContain("openai");

      const models = await app.inject({ method: "GET", url: "/api/models" });
      expect(models.statusCode).toBe(404);
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

  // Gateway P4 Task 2: reasoning/generation config objects were unified into a single
  // gateway-native dotted `params` record. The API keeps legacy `reasoning`/`generation`
  // request/response fields working for the untouched SPA via a compat layer.
  // P5 T6: the SPA writes gateway-native `params` everywhere now (the legacy `reasoning`/
  // `generation` compat layer — withLegacyViews/resolveParamsPatch — is gone). These pins cover
  // native `params` semantics end to end: PUT stores it exactly, GET/list never carry synthesized
  // `reasoning`/`generation`, absent `params` on a PUT preserves what's stored, and a stray legacy
  // field in a request body is silently stripped by zod (unknown keys, not a validation error)
  // rather than resurrecting the old merge behavior.
  describe("waifu/agent gateway params (native)", () => {
    it("PUT waifu params stores them exactly; GET and list return params with no synthesized reasoning/generation", async () => {
      const { app } = await makeApp();
      try {
        const create = await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "params-test", name: "ParamsTest", displayName: "ParamsTest" }
        });
        expect(create.statusCode).toBe(201);
        expect(create.json()).not.toHaveProperty("reasoning");
        expect(create.json()).not.toHaveProperty("generation");

        const update = await app.inject({
          method: "PUT",
          url: "/api/waifus/params-test",
          payload: {
            revision: 0,
            params: { temperature: 0.5, "reasoning.effort": "high" }
          }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().params).toEqual({ temperature: 0.5, "reasoning.effort": "high" });
        expect(update.json()).not.toHaveProperty("reasoning");
        expect(update.json()).not.toHaveProperty("generation");

        const get = await app.inject({ method: "GET", url: "/api/waifus/params-test" });
        expect(get.statusCode).toBe(200);
        expect(get.json().params).toEqual({ temperature: 0.5, "reasoning.effort": "high" });
        expect(get.json()).not.toHaveProperty("reasoning");
        expect(get.json()).not.toHaveProperty("generation");

        const list = await app.inject({ method: "GET", url: "/api/waifus" });
        const listed = list.json().waifus.find((w: { id: string }) => w.id === "params-test");
        expect(listed.params).toEqual({ temperature: 0.5, "reasoning.effort": "high" });
        expect(listed).not.toHaveProperty("reasoning");
        expect(listed).not.toHaveProperty("generation");
      } finally {
        await app.close();
      }
    });

    it("PUT waifu params replaces the stored value wholesale, not merged with the previous value", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "params-replace", name: "ParamsReplace", displayName: "ParamsReplace" }
        });
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/waifus/params-replace",
          payload: { revision: 0, params: { temperature: 0.5, topK: 40 } }
        });
        expect(seeded.json().params).toEqual({ temperature: 0.5, topK: 40 });

        const replaced = await app.inject({
          method: "PUT",
          url: "/api/waifus/params-replace",
          payload: { revision: 1, params: { "reasoning.effort": "high" } }
        });
        expect(replaced.statusCode).toBe(200);
        // topK/temperature from the previous write are gone — params is a full replace, not a merge.
        expect(replaced.json().params).toEqual({ "reasoning.effort": "high" });
      } finally {
        await app.close();
      }
    });

    it("PUT waifu without params leaves previously-stored params untouched", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "params-keep", name: "ParamsKeep", displayName: "ParamsKeep" }
        });
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/waifus/params-keep",
          payload: { revision: 0, params: { temperature: 0.6 } }
        });
        expect(seeded.json().params).toEqual({ temperature: 0.6 });

        const renamed = await app.inject({
          method: "PUT",
          url: "/api/waifus/params-keep",
          payload: { revision: 1, persona: "renamed persona" }
        });
        expect(renamed.statusCode).toBe(200);
        expect(renamed.json().persona).toBe("renamed persona");
        expect(renamed.json().params).toEqual({ temperature: 0.6 });

        const get = await app.inject({ method: "GET", url: "/api/waifus/params-keep" });
        expect(get.json().params).toEqual({ temperature: 0.6 });
      } finally {
        await app.close();
      }
    });

    it("PUT waifu with a stray legacy reasoning/generation body is silently stripped; stored params are unaffected", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "stray-legacy", name: "StrayLegacy", displayName: "StrayLegacy" }
        });
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/waifus/stray-legacy",
          payload: { revision: 0, params: { temperature: 0.7 } }
        });
        expect(seeded.json().params).toEqual({ temperature: 0.7 });

        // The compat layer that used to read these fields is gone — they're just unrecognized
        // body keys now, dropped by zod's default (non-strict) object parsing. No 400, no effect.
        const update = await app.inject({
          method: "PUT",
          url: "/api/waifus/stray-legacy",
          payload: {
            revision: 1,
            persona: "still updates",
            reasoning: { enabled: true, effort: "high" },
            generation: { temperature: 0.1 }
          }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().persona).toBe("still updates");
        expect(update.json().params).toEqual({ temperature: 0.7 });
        expect(update.json()).not.toHaveProperty("reasoning");
        expect(update.json()).not.toHaveProperty("generation");
      } finally {
        await app.close();
      }
    });

    it("POST /api/waifus with params on create stores them; a stray legacy body on create is stripped", async () => {
      const { app } = await makeApp();
      try {
        const create = await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: {
            id: "params-create",
            name: "ParamsCreate",
            displayName: "ParamsCreate",
            params: { temperature: 0.3, topP: 0.8, "reasoning.enabled": true },
            generation: { temperature: 0.99 },
            reasoning: { effort: "low" }
          }
        });
        expect(create.statusCode).toBe(201);
        expect(create.json().params).toEqual({ temperature: 0.3, topP: 0.8, "reasoning.enabled": true });
        expect(create.json()).not.toHaveProperty("reasoning");
        expect(create.json()).not.toHaveProperty("generation");
      } finally {
        await app.close();
      }
    });

    it("PUT orchestrator config params stores them exactly; GET returns params with no synthesized reasoning", async () => {
      const { app } = await makeApp();
      try {
        const update = await app.inject({
          method: "PUT",
          url: "/api/orchestrator/config",
          payload: {
            revision: 0,
            enabled: true,
            params: { "reasoning.enabled": true, "reasoning.effort": "high" }
          }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().params).toEqual({ "reasoning.enabled": true, "reasoning.effort": "high" });
        expect(update.json()).not.toHaveProperty("reasoning");
        expect(update.json()).not.toHaveProperty("generation");

        const get = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
        expect(get.statusCode).toBe(200);
        expect(get.json().params).toEqual({ "reasoning.enabled": true, "reasoning.effort": "high" });
        expect(get.json()).not.toHaveProperty("reasoning");
        expect(get.json()).not.toHaveProperty("generation");
      } finally {
        await app.close();
      }
    });

    it("PUT orchestrator config with a stray legacy reasoning body is silently stripped; stored params are unaffected", async () => {
      const { app } = await makeApp();
      try {
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/orchestrator/config",
          payload: { revision: 0, enabled: true, params: { "reasoning.effort": "medium" } }
        });
        expect(seeded.json().params).toEqual({ "reasoning.effort": "medium" });

        const update = await app.inject({
          method: "PUT",
          url: "/api/orchestrator/config",
          payload: {
            revision: 1,
            enabled: true,
            reasoning: { enabled: true, effort: "high" }
          }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().params).toEqual({ "reasoning.effort": "medium" });
        expect(update.json()).not.toHaveProperty("reasoning");

        const get = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
        expect(get.json().params).toEqual({ "reasoning.effort": "medium" });
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
    it("PUT stage-manager config omitting contextWindow/prompt/directiveCooldown/promptSections leaves them untouched (reviewer repro)", async () => {
      const { app } = await makeApp();
      try {
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/stage-manager/config",
          payload: {
            revision: 0,
            enabled: true,
            providerId: "openai",
            modelId: "gpt-5.4-mini",
            contextWindow: 80,
            prompt: "Direct the scene with care and continuity.",
            directiveCooldown: 5,
            promptSections: { pausePlanning: false, messageStructure: false }
          }
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json().contextWindow).toBe(80);
        expect(seeded.json().revision).toBe(1);

        // The real agent-view PUT body: only the fields the view actually edits.
        const patched = await app.inject({
          method: "PUT",
          url: "/api/stage-manager/config",
          payload: {
            revision: 1,
            providerId: "openai",
            modelId: "gpt-5.4-mini",
            enabled: true,
            params: {}
          }
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().contextWindow).toBe(80);
        expect(patched.json().prompt).toBe("Direct the scene with care and continuity.");
        expect(patched.json().directiveCooldown).toBe(5);
        expect(patched.json().promptSections).toEqual({ pausePlanning: false, messageStructure: false });

        const get = await app.inject({ method: "GET", url: "/api/stage-manager/config" });
        expect(get.statusCode).toBe(200);
        expect(get.json().contextWindow).toBe(80);
        expect(get.json().prompt).toBe("Direct the scene with care and continuity.");
        expect(get.json().directiveCooldown).toBe(5);
        expect(get.json().promptSections).toEqual({ pausePlanning: false, messageStructure: false });
      } finally {
        await app.close();
      }
    });

    it("PUT waifu with only {revision, displayName} leaves contextWindow/tools/promptLayout untouched", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "patch-true", name: "PatchTrue", displayName: "PatchTrue" }
        });

        const customLayout = {
          top: [{ kind: "block", blockId: "identity", enabled: false }],
          mid: [],
          trailing: []
        };
        const seeded = await app.inject({
          method: "PUT",
          url: "/api/waifus/patch-true",
          payload: {
            revision: 0,
            contextWindow: 77,
            tools: { toolUse: false },
            promptLayout: customLayout
          }
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json().contextWindow).toBe(77);
        expect(seeded.json().tools).toEqual({ toolUse: false });
        expect(seeded.json().promptLayout).toEqual(customLayout);

        const renamed = await app.inject({
          method: "PUT",
          url: "/api/waifus/patch-true",
          payload: { revision: 1, displayName: "New Display Name" }
        });
        expect(renamed.statusCode).toBe(200);
        expect(renamed.json().displayName).toBe("New Display Name");
        expect(renamed.json().contextWindow).toBe(77);
        expect(renamed.json().tools).toEqual({ toolUse: false });
        expect(renamed.json().promptLayout).toEqual(customLayout);

        const get = await app.inject({ method: "GET", url: "/api/waifus/patch-true" });
        expect(get.statusCode).toBe(200);
        expect(get.json().contextWindow).toBe(77);
        expect(get.json().tools).toEqual({ toolUse: false });
        expect(get.json().promptLayout).toEqual(customLayout);
      } finally {
        await app.close();
      }
    });

    it("PUT waifu with an explicit contextWindow still stores the new value", async () => {
      const { app } = await makeApp();
      try {
        await app.inject({
          method: "POST",
          url: "/api/waifus",
          payload: { id: "explicit-write", name: "ExplicitWrite", displayName: "ExplicitWrite" }
        });

        const update = await app.inject({
          method: "PUT",
          url: "/api/waifus/explicit-write",
          payload: { revision: 0, contextWindow: 40 }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().contextWindow).toBe(40);

        const get = await app.inject({ method: "GET", url: "/api/waifus/explicit-write" });
        expect(get.statusCode).toBe(200);
        expect(get.json().contextWindow).toBe(40);
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
        expect(created.contextWindow).toBe(50);
        expect(created.tools).toEqual({ toolUse: true });
        expect(created.promptLayout).toEqual(defaultWaifuPromptLayout());
      } finally {
        await app.close();
      }
    });

    it("PUT server config omitting memoryInjectionLimit (real ServersView save body) leaves it untouched (reviewer repro)", async () => {
      const { app } = await makeApp();
      try {
        const guildId = "guild-patch-true";
        const seeded = await app.inject({
          method: "PUT",
          url: `/api/servers/${guildId}`,
          payload: {
            revision: 0,
            name: "Test Guild",
            enabled: true,
            contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 },
            memoryInjectionLimit: 30,
            tools: { pickNextWaifu: false, shortTermMemory: true },
            channels: {}
          }
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json().memoryInjectionLimit).toBe(30);
        expect(seeded.json().revision).toBe(1);

        // The real ServersView save body (src/frontend/views/ServersView.tsx): no UI exists for
        // memoryInjectionLimit, so it is never sent.
        const patched = await app.inject({
          method: "PUT",
          url: `/api/servers/${guildId}`,
          payload: {
            revision: 1,
            name: "Test Guild",
            enabled: true,
            contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 },
            tools: { pickNextWaifu: false, shortTermMemory: true },
            channels: {}
          }
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().memoryInjectionLimit).toBe(30);

        const list = await app.inject({ method: "GET", url: "/api/servers" });
        expect(list.statusCode).toBe(200);
        const server = (list.json().servers as Array<{ guildId: string; memoryInjectionLimit: number }>).find(
          (entry) => entry.guildId === guildId
        );
        expect(server?.memoryInjectionLimit).toBe(30);
      } finally {
        await app.close();
      }
    });

    it("PUT server config with an explicit memoryInjectionLimit still stores the new value", async () => {
      const { app } = await makeApp();
      try {
        const guildId = "guild-explicit-write";
        const seeded = await app.inject({
          method: "PUT",
          url: `/api/servers/${guildId}`,
          payload: { revision: 0, memoryInjectionLimit: 30 }
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json().memoryInjectionLimit).toBe(30);

        const updated = await app.inject({
          method: "PUT",
          url: `/api/servers/${guildId}`,
          payload: { revision: 1, memoryInjectionLimit: 45 }
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json().memoryInjectionLimit).toBe(45);

        const list = await app.inject({ method: "GET", url: "/api/servers" });
        const server = (list.json().servers as Array<{ guildId: string; memoryInjectionLimit: number }>).find(
          (entry) => entry.guildId === guildId
        );
        expect(server?.memoryInjectionLimit).toBe(45);
      } finally {
        await app.close();
      }
    });
  });

  it("creates user memories as pinned and preserves pinned state across edits", async () => {
    const { app, root } = await makeApp();
    const now = new Date().toISOString();
    await writeFile(
      path.join(root, "user", "memories.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
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

// Gateway P4 Task 4: provider ids widen from the legacy 6-value enum to any id the gateway
// registry knows, and writes that carry a modelId are validated against the registry
// (unknown provider/model -> 400; params the model's descriptor forbids -> 400
// unsupported_parameter) instead of failing later at chat time.
describe("Provider id widening + write validation (Gateway P4 Task 4)", () => {
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
      expect(stale.json().latest.revision).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a credential write for a provider id the gateway registry doesn't know", async () => {
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

  it("rejects a waifu param write that violates the target model's registry descriptor", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "param-violation", name: "ParamViolation", displayName: "ParamViolation" }
      });
      expect(create.statusCode).toBe(201);

      // deepseek-v4-flash's registry descriptor (verified confidence) caps temperature at 2.
      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/param-violation",
        payload: {
          revision: 0,
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          params: { temperature: 3 }
        }
      });
      expect(update.statusCode).toBe(400);
      const body = update.json();
      expect(body.details.error).toBe("unsupported_parameter");
      expect(body.details.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ param: "temperature", code: "out_of_range" })])
      );
    } finally {
      await app.close();
    }
  });

  it("rejects a waifu param write that violates a named constraint rule (violations[].rule is populated)", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "param-violation-rule", name: "ParamViolationRule", displayName: "ParamViolationRule" }
      });
      expect(create.statusCode).toBe(201);

      // grok-4.3 defaults reasoning.effort to "low", which activates the
      // reasoning-no-penalties-or-stop constraint and forbids stopSequences. Unlike the
      // out-of-range descriptor check above, this is a constraint-rule violation, so the
      // gateway's violation carries a ruleId -> assertParamsValid's `rule` field is populated.
      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/param-violation-rule",
        payload: {
          revision: 0,
          providerId: "xai",
          modelId: "grok-4.3",
          params: { stopSequences: ["x"] }
        }
      });
      expect(update.statusCode).toBe(400);
      const body = update.json();
      expect(body.details.error).toBe("unsupported_parameter");
      expect(body.details.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            param: "stopSequences",
            code: "forbidden_param",
            rule: "reasoning-no-penalties-or-stop"
          })
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("accepts a waifu param write within the target model's registry descriptor", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "param-ok", name: "ParamOk", displayName: "ParamOk" }
      });
      expect(create.statusCode).toBe(201);

      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/param-ok",
        payload: {
          revision: 0,
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          params: { temperature: 1.5 }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().modelId).toBe("deepseek-v4-flash");
      expect(update.json().params).toEqual({ temperature: 1.5 });
    } finally {
      await app.close();
    }
  });

  it("rejects a waifu model assignment the gateway registry doesn't know", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "model-unknown", name: "ModelUnknown", displayName: "ModelUnknown" }
      });
      expect(create.statusCode).toBe(201);

      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/model-unknown",
        payload: {
          revision: 0,
          providerId: "deepseek",
          modelId: "not-a-real-model"
        }
      });
      expect(update.statusCode).toBe(400);
      expect(update.json().details).toEqual({
        error: "unknown_model",
        providerId: "deepseek",
        modelId: "not-a-real-model"
      });
    } finally {
      await app.close();
    }
  });

  it("leaves params unvalidated when no modelId is set (validated at model-assignment time instead)", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "no-model-yet", name: "NoModelYet", displayName: "NoModelYet" }
      });
      expect(create.statusCode).toBe(201);

      // temperature: 999 would violate every registry descriptor, but with no modelId assigned
      // there is nothing to validate against yet.
      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/no-model-yet",
        payload: {
          revision: 0,
          params: { temperature: 999 }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().params).toEqual({ temperature: 999 });
    } finally {
      await app.close();
    }
  });
});

// Gateway P6 Task 4: write-contract hardening bundle.
//   1. explicit-null unset: sending `providerId`/`modelId: null` on a waifu or agent PUT clears
//      the stored model assignment (deletes the key so stored JSON never carries nulls);
//      an absent key still preserves whatever is currently stored (PATCH-true semantics).
//   2. normalize legacy/derived ids on write: assertModelWriteValid's resolved (providerId,
//      modelId) pair is what gets persisted, not the literal input pair — this supersedes the
//      P4 store-literal deviation.
//   3. personaDigest is server-managed: a personaDigest sent on POST /api/waifus is stripped
//      as an unknown key, never stored.
//   4. DiscordBots write path requires `enabled` explicitly per bot object (no silent default).
describe("Write-contract hardening (Gateway P6 Task 4)", () => {
  it("PUT waifu with explicit null providerId/modelId clears the stored model assignment", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "unset-model", name: "UnsetModel", displayName: "UnsetModel" }
      });
      expect(create.statusCode).toBe(201);

      const seeded = await app.inject({
        method: "PUT",
        url: "/api/waifus/unset-model",
        payload: { revision: 0, providerId: "openai", modelId: "gpt-5.4-mini" }
      });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json().providerId).toBe("openai");
      expect(seeded.json().modelId).toBe("gpt-5.4-mini");

      const unset = await app.inject({
        method: "PUT",
        url: "/api/waifus/unset-model",
        payload: { revision: 1, providerId: null, modelId: null }
      });
      expect(unset.statusCode).toBe(200);
      const unsetBody = unset.json();
      expect("providerId" in unsetBody).toBe(false);
      expect("modelId" in unsetBody).toBe(false);

      const get = await app.inject({ method: "GET", url: "/api/waifus/unset-model" });
      const getBody = get.json();
      expect("providerId" in getBody).toBe(false);
      expect("modelId" in getBody).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("PUT waifu omitting providerId/modelId preserves the stored model assignment (absent vs explicit null)", async () => {
    const { app } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "preserve-model", name: "PreserveModel", displayName: "PreserveModel" }
      });
      const seeded = await app.inject({
        method: "PUT",
        url: "/api/waifus/preserve-model",
        payload: { revision: 0, providerId: "openai", modelId: "gpt-5.4-mini" }
      });
      expect(seeded.statusCode).toBe(200);

      const patched = await app.inject({
        method: "PUT",
        url: "/api/waifus/preserve-model",
        payload: { revision: 1, displayName: "Renamed" }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().providerId).toBe("openai");
      expect(patched.json().modelId).toBe("gpt-5.4-mini");
    } finally {
      await app.close();
    }
  });

  it("PUT orchestrator config with explicit null providerId/modelId clears the stored assignment", async () => {
    const { app } = await makeApp();
    try {
      const seeded = await app.inject({
        method: "PUT",
        url: "/api/orchestrator/config",
        payload: { revision: 0, enabled: true, providerId: "openai", modelId: "gpt-5.4-mini" }
      });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json().providerId).toBe("openai");

      const unset = await app.inject({
        method: "PUT",
        url: "/api/orchestrator/config",
        payload: { revision: 1, providerId: null, modelId: null }
      });
      expect(unset.statusCode).toBe(200);
      const body = unset.json();
      expect("providerId" in body).toBe(false);
      expect("modelId" in body).toBe(false);

      const get = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
      const getBody = get.json();
      expect("providerId" in getBody).toBe(false);
      expect("modelId" in getBody).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("PUT waifu with modelId 'gpt-4o' (legacy id) stores the normalized openai/gpt-5-mini pair", async () => {
    const { app } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "legacy-model", name: "LegacyModel", displayName: "LegacyModel" }
      });
      const update = await app.inject({
        method: "PUT",
        url: "/api/waifus/legacy-model",
        payload: { revision: 0, modelId: "gpt-4o" }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().providerId).toBe("openai");
      expect(update.json().modelId).toBe("gpt-5-mini");

      const get = await app.inject({ method: "GET", url: "/api/waifus/legacy-model" });
      expect(get.json().providerId).toBe("openai");
      expect(get.json().modelId).toBe("gpt-5-mini");
    } finally {
      await app.close();
    }
  });

  it("POST /api/waifus with modelId 'gpt-4o' (legacy id) stores the normalized openai/gpt-5-mini pair", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "legacy-model-create", name: "LegacyModelCreate", displayName: "LegacyModelCreate", modelId: "gpt-4o" }
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().providerId).toBe("openai");
      expect(create.json().modelId).toBe("gpt-5-mini");
    } finally {
      await app.close();
    }
  });

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

describe("LLM gateway mount (/api/llm)", () => {
  it("serves the gateway model registry through the mount", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/llm/v1/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as { models: Array<Record<string, unknown>> };
      // 98 since gateway 0.1.1 dropped two stale openrouter routes (owl-alpha, mimo-v2-flash).
      expect(body.models).toHaveLength(98);
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

describe("Gateway registry proxy (/api/providers); /api/models deleted (Gateway P6 Task 3)", () => {
  it("GET /api/models is gone", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/models" });
      expect(models.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("exposes credential status for the full 14-provider gateway registry on /api/providers, plus gatewayProviders", async () => {
    const { app } = await makeApp();
    try {
      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      const body = providers.json() as {
        revision: number;
        updatedAt: string;
        providers: Array<{ id: string; displayName: string; docsUrl?: string; credentials: { configured: boolean } }>;
        gatewayProviders: Array<{ id: string; credentialConfigured: boolean }>;
      };
      // providers now covers the full registry (14), not just the legacy 6-id enum.
      expect(body.providers).toHaveLength(14);
      expect(body.providers.map((p) => p.id)).toContain("openrouter");
      expect(body.providers.every((p) => p.credentials.configured === false)).toBe(true);
      // native provider carries a docsUrl from the static map.
      expect(body.providers.find((p) => p.id === "openai")?.docsUrl).toBe(
        "https://developers.openai.com/api/docs/models"
      );

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
      // and the plain providers[] credential status updates too, for the newly-covered provider.
      expect(afterBody.providers.find((p) => p.id === "deepseek")?.credentials.configured).toBe(true);
    } finally {
      await app.close();
    }
  });

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

  it("POST /digest returns 409 when stage-manager provider has no API key configured", async () => {
    const { app } = await makeApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "digest-no-key", name: "DigestNoKey", displayName: "DigestNoKey" }
      });
      expect(create.statusCode).toBe(201);

      const config = await app.inject({
        method: "PUT",
        url: "/api/stage-manager/config",
        payload: {
          revision: 0,
          enabled: true,
          providerId: "openai",
          modelId: "gpt-5.4-mini"
        }
      });
      expect(config.statusCode).toBe(200);

      const digest = await app.inject({
        method: "POST",
        url: "/api/waifus/digest-no-key/digest"
      });
      expect(digest.statusCode).toBe(409);
      expect(digest.json().message).toBe("Provider openai has no API key configured.");
    } finally {
      await app.close();
    }
  });
});
