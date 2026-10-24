import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { appendModelWarnings, readModelWarnings } from "../src/models/modelWarnings.js";
import { DEFAULT_ALLOWED_ROUTES } from "../src/models/catalog.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
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
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
  apps.push(app);
  return { app, root };
}

type ModelsBody = {
  catalogVersion: string;
  maxOutputUsdPerMTok: number;
  models: Array<{ id: string; providerId: string; modelId: string; efforts: string[]; contributor: boolean; credentialsConfigured: boolean }>;
  hidden: Array<{ id: string; reason: string }>;
};

describe("GET /api/models (Living cast §9.2)", () => {
  it("is a reviewed safe route; the retired model routes are not in the manifest", () => {
    expect(ROUTE_POLICY_MANIFEST.find((entry) => entry.method === "GET" && entry.path === "/api/models")).toBeDefined();
    expect(ROUTE_POLICY_MANIFEST.find((entry) => entry.method === "GET" && entry.path === "/api/detector/models")).toBeDefined();
    for (const retired of ["/api/llm/*", "/api/orchestrator/config", "/api/orchestrator/one-shot/models", "/api/memories", "/api/waifus/:waifuId/digest", "/api/runtime/stop"]) {
      expect(ROUTE_POLICY_MANIFEST.some((entry) => entry.path === retired), retired).toBe(false);
    }
  });

  it("lists the curated routes with efforts, contributor labels and live credential status, plus what is hidden and why", async () => {
    const { app } = await makeApp();
    const first = (await app.inject({ method: "GET", url: "/api/models" })).json<ModelsBody>();
    expect(first.maxOutputUsdPerMTok).toBe(10);
    expect(first.catalogVersion).toMatch(/winter/);
    // winter 0.0.56 carries every curated route, direct and through OpenRouter.
    expect(first.models.map((model) => model.id)).toEqual([...DEFAULT_ALLOWED_ROUTES]);
    expect(first.hidden).toEqual([]);
    expect(first.models.every((model) => model.credentialsConfigured === false)).toBe(true);
    expect(first.models.find((model) => model.id === "meta/muse-spark-1.3-contributor")?.contributor).toBe(true);
    expect(first.models.find((model) => model.id === "openrouter/meta/muse-spark-1.3-contributor")?.contributor).toBe(true);

    await app.inject({ method: "PUT", url: "/api/providers/deepseek/credentials", payload: { apiKey: "sk-test-models" } });
    const after = await app.inject({ method: "GET", url: "/api/models" });
    expect(after.json<ModelsBody>().models.find((model) => model.id === "deepseek/deepseek-flash")?.credentialsConfigured).toBe(true);
    expect(after.body).not.toContain("sk-test-models");
  });

  it("follows config.toml [models]: the allow-list and the output price cap", async () => {
    const { app } = await makeApp();
    const put = await app.inject({ method: "PUT", url: "/api/config", payload: { models: { allowed: ["openai/gpt-6-luna", "openai/gpt-6.1-sol"], maxOutputUsdPerMTok: 5 } } });
    expect(put.statusCode, put.body).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/models" })).json<ModelsBody>();
    expect(body.models.map((model) => model.id)).toEqual(["openai/gpt-6-luna"]);
    expect(body.hidden).toEqual([{ id: "openai/gpt-6.1-sol", reason: "over_price_cap" }]);
    // A write is validated against the same view.
    const refused = await app.inject({
      method: "POST",
      url: "/api/waifus",
      payload: { id: "momo", name: "Momo", displayName: "Momo", model: { providerId: "deepseek", modelId: "deepseek-flash" } }
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ details: { error: "model_not_available" } });
  });
});

describe("/api/providers over the winter catalog", () => {
  it("lists the curated and detector providers with redacted credential status and the catalog version", async () => {
    const { app } = await makeApp();
    await app.inject({ method: "PUT", url: "/api/providers/openrouter/credentials", payload: { apiKey: "or-test_dummy1234567890" } });
    const body = (await app.inject({ method: "GET", url: "/api/providers" })).json<{
      catalogVersion: string;
      providers: Array<{ id: string; displayName: string; credentials: { configured: boolean; keyHint?: string } }>;
    }>();
    expect(body.catalogVersion).toMatch(/winter/);
    // The model providers, plus the optional Exa web-search key (Living cast §6.8).
    expect(body.providers.map((provider) => provider.id).sort()).toEqual(["anthropic", "deepseek", "exa", "meta", "openai", "openrouter"]);
    expect(body.providers.find((provider) => provider.id === "exa")).toMatchObject({ displayName: "Exa (web search)", credentials: { configured: false } });
    expect(body.providers.find((provider) => provider.id === "openrouter")?.credentials).toMatchObject({ configured: true, keyHint: "****7890" });
    expect(body).not.toHaveProperty("gatewayProviders");
    // A provider outside the curated list appears once it has a key (so it can be removed).
    await app.inject({ method: "PUT", url: "/api/providers/xai/credentials", payload: { apiKey: "xai-key-12345678" } });
    const again = (await app.inject({ method: "GET", url: "/api/providers" })).json<{ providers: Array<{ id: string }> }>();
    expect(again.providers.map((provider) => provider.id)).toContain("xai");
    // The Exa key is stored like a model key (and never echoed back).
    const exa = await app.inject({ method: "PUT", url: "/api/providers/exa/credentials", payload: { apiKey: "exa-key-abcdef123456" } });
    expect(exa.statusCode, exa.body).toBe(200);
    expect(exa.body).not.toContain("exa-key-abcdef123456");
  });
});

describe("model writes (waifus and the assistant)", () => {
  it("stores a curated choice, refuses unknown and hidden routes and unlisted efforts", async () => {
    const { app } = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/waifus",
      payload: { id: "aria", name: "Aria", displayName: "Aria", model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "max" } }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "max" });

    const put = (model: unknown, revision: number) => app.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision, model } });
    const unknown = await put({ providerId: "openai", modelId: "gpt-4o" }, 0);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ details: { error: "model_not_available", providerId: "openai", modelId: "gpt-4o" } });
    await app.inject({ method: "PUT", url: "/api/config", payload: { models: { maxOutputUsdPerMTok: 1 } } });
    const hidden = await put({ providerId: "openrouter", modelId: "openai/gpt-6.1-sol" }, 0);
    expect(hidden.json()).toMatchObject({ details: { error: "model_not_available", reason: "over_price_cap" } });
    await app.inject({ method: "PUT", url: "/api/config", payload: { models: { maxOutputUsdPerMTok: 10 } } });
    const effort = await put({ providerId: "deepseek", modelId: "deepseek-flash", effort: "medium" }, 0);
    expect(effort.statusCode).toBe(400);
    expect(effort.json()).toMatchObject({ details: { error: "unsupported_effort", effort: "medium", efforts: ["low", "high", "max"] } });

    // Omitted keeps, null unsets.
    const renamed = await app.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: 0, displayName: "Aria!" } });
    expect(renamed.json().model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "max" });
    const unset = await put(null, renamed.json().revision);
    expect(unset.statusCode).toBe(200);
    expect(unset.json()).not.toHaveProperty("model");
  });

  it("the assistant's own model is validated the same way and defaults to unset", async () => {
    const { app } = await makeApp();
    const initial = await app.inject({ method: "GET", url: "/api/assistant/config" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).not.toHaveProperty("model");
    expect((await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { model: { providerId: "anthropic", modelId: "claude-opus-4-7" } } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { model: { providerId: "openai", modelId: "gpt-6-luna", effort: "none" } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().model).toEqual({ providerId: "openai", modelId: "gpt-6-luna", effort: "none" });
    const cleared = await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { revision: saved.json().revision, model: null } });
    expect(cleared.json()).not.toHaveProperty("model");
  });
});

async function writeWaifu(root: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const file = path.join(root, "user", "waifus", id, "waifu.json");
  await mkdir(path.dirname(file), { recursive: true });
  const name = id[0]!.toUpperCase() + id.slice(1);
  await writeFile(file, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: new Date().toISOString(), id, name, displayName: name, persona: "p", ...extra }));
}

describe("editing records whose model is no longer offered (review I3)", () => {
  // Never curated, so it is unoffered on every winter version.
  const RETIRED = { providerId: "anthropic", modelId: "claude-opus-4-7" };

  it("a persona edit that resends the stored model succeeds; changing the model is validated", async () => {
    const { app, root } = await makeApp();
    await writeWaifu(root, "riko", { model: RETIRED });
    // The Cast editor's save shape: every field, the model included.
    const edit = await app.inject({ method: "PUT", url: "/api/waifus/riko", payload: { revision: 1, persona: "edited", model: RETIRED, botId: null } });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ persona: "edited", model: RETIRED });
    // Same route, a different effort is a change: validated (and refused).
    const effort = await app.inject({ method: "PUT", url: "/api/waifus/riko", payload: { revision: 2, model: { ...RETIRED, effort: "high" } } });
    expect(effort.statusCode).toBe(400);
    const other = await app.inject({ method: "PUT", url: "/api/waifus/riko", payload: { revision: 2, model: { providerId: "openai", modelId: "gpt-4o" } } });
    expect(other.json()).toMatchObject({ details: { error: "model_not_available" } });
  });

  it("the assistant config resaves an unoffered stored model unchanged", async () => {
    const { app, root } = await makeApp();
    const file = path.join(root, "user", "assistant", "config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: new Date().toISOString(), model: RETIRED }));
    const same = await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { model: RETIRED } });
    expect(same.statusCode, same.body).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { model: { providerId: "openai", modelId: "gpt-4o" } } })).statusCode).toBe(400);
  });
});

describe("/api/runtime models.warnings", () => {
  it("a save that leaves the model as it was keeps the notices; dismissing removes them (persisted ones only)", async () => {
    const { app, root } = await makeApp();
    const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
    await writeWaifu(root, "aria", { model: SONNET });
    await appendModelWarnings(root, [
      { scope: "waifu:aria", code: "effort_dropped", detail: "Effort \"turbo\" is not listed.", previous: "anthropic/claude-sonnet-5-5 (effort turbo)" }
    ]);
    // The Cast editor's persona-only save resends the (offered) model unchanged.
    const persona = await app.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: 1, persona: "edited", model: SONNET, botId: null } });
    expect(persona.statusCode, persona.body).toBe(200);
    expect(await readModelWarnings(root)).toHaveLength(1);
    const view = (await app.inject({ method: "GET", url: "/api/runtime" })).json<{ models: { warnings: Array<Record<string, unknown>> } }>().models.warnings;
    expect(view).toContainEqual(expect.objectContaining({ scope: "waifu:aria", label: "Aria", dismissible: true }));

    expect(ROUTE_POLICY_MANIFEST.find((entry) => entry.method === "DELETE" && entry.path === "/api/runtime/model-warnings/:scope")).toBeDefined();
    const dismissed = await app.inject({ method: "DELETE", url: `/api/runtime/model-warnings/${encodeURIComponent("waifu:aria")}` });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json()).toEqual({ scope: "waifu:aria", dismissed: 1 });
    expect(await readModelWarnings(root)).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/api/runtime/model-warnings/assistant" })).json()).toEqual({ scope: "assistant", dismissed: 0 });
    expect((await app.inject({ method: "DELETE", url: "/api/runtime/model-warnings/nonsense" })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/runtime/model-warnings/${encodeURIComponent("waifu:..")}` })).statusCode).toBe(400);

    // A live notice is not dismissible: it holds while its cause does.
    await writeWaifu(root, "riko", { model: { providerId: "anthropic", modelId: "claude-opus-4-7" } });
    const live = (await app.inject({ method: "GET", url: "/api/runtime" })).json<{ models: { warnings: Array<Record<string, unknown>> } }>().models.warnings;
    expect(live).toContainEqual(expect.objectContaining({ scope: "waifu:riko", code: "model_unavailable", dismissible: false }));
  });

  it("deleting a waifu clears her model notices", async () => {
    const { app, root } = await makeApp();
    await writeWaifu(root, "opus");
    await appendModelWarnings(root, [
      { scope: "waifu:opus", code: "model_unmapped", detail: "x", previous: "anthropic/claude-opus-4-7" },
      { scope: "assistant", code: "model_unmapped", detail: "y" }
    ]);
    const deleted = await app.inject({ method: "DELETE", url: "/api/waifus/opus", payload: { revision: 1 } });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await readModelWarnings(root)).map((warning) => warning.scope)).toEqual(["assistant"]);
  });

  it("keeps an unmapped model's record until a real model is saved; shows her name and the old model (review I4)", async () => {
    const { app, root } = await makeApp();
    await writeWaifu(root, "opus");
    await appendModelWarnings(root, [
      { scope: "waifu:opus", code: "model_unmapped", detail: "anthropic/claude-opus-4-7 has no curated equivalent; pick a model again.", previous: "anthropic/claude-opus-4-7" }
    ]);
    // The Cast editor sends `model: null` for a waifu without a model: never clears the record.
    const persona = await app.inject({ method: "PUT", url: "/api/waifus/opus", payload: { revision: 1, persona: "edited", model: null, botId: null } });
    expect(persona.statusCode, persona.body).toBe(200);
    expect(await readModelWarnings(root)).toHaveLength(1);

    const view = (await app.inject({ method: "GET", url: "/api/runtime" })).json<{ models: { warnings: Array<Record<string, unknown>> } }>().models.warnings;
    expect(view).toContainEqual(expect.objectContaining({ scope: "waifu:opus", label: "Opus", code: "model_unmapped", previous: "anthropic/claude-opus-4-7" }));

    const picked = await app.inject({ method: "PUT", url: "/api/waifus/opus", payload: { revision: 2, model: { providerId: "openai", modelId: "gpt-6-luna" } } });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(await readModelWarnings(root)).toEqual([]);
  });

  it("shows persisted migration warnings and live unavailable choices; saving a model clears that scope", async () => {
    const { app, root } = await makeApp();
    await appendModelWarnings(root, [{ scope: "waifu:opus", code: "model_unmapped", detail: "anthropic/claude-opus-4-7 has no curated equivalent; pick a model again." }]);
    // A stored choice the curated list does not offer.
    const file = path.join(root, "user", "waifus", "riko", "waifu.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: new Date().toISOString(), id: "riko", name: "Riko", displayName: "Riko", model: { providerId: "anthropic", modelId: "claude-opus-4-7" } }));
    const opusFile = path.join(root, "user", "waifus", "opus", "waifu.json");
    await mkdir(path.dirname(opusFile), { recursive: true });
    await writeFile(opusFile, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: new Date().toISOString(), id: "opus", name: "Opus", displayName: "Opus" }));

    const warnings = (await app.inject({ method: "GET", url: "/api/runtime" })).json<{ models: { warnings: Array<{ scope: string; code: string }> } }>().models.warnings;
    expect(warnings).toContainEqual(expect.objectContaining({ scope: "waifu:opus", code: "model_unmapped" }));
    expect(warnings).toContainEqual(expect.objectContaining({ scope: "waifu:riko", code: "model_unavailable" }));

    const saved = await app.inject({ method: "PUT", url: "/api/waifus/opus", payload: { revision: 0, model: { providerId: "openai", modelId: "gpt-6-luna" } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await readModelWarnings(root)).some((warning) => warning.scope === "waifu:opus")).toBe(false);
  });
});
