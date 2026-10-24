import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import {
  convertModelFields,
  effortFromParams,
  FAMILY_ROUTES,
  mapGatewayModel,
  migrateLivingCastModels,
  modelArchivePath,
  modelFamily,
  providerArchivePath,
  winterProviderId
} from "../src/backend/migrationSteps/livingCastModels.js";
import { checkStoredModelEfforts } from "../src/backend/migrationSteps/modelEffortCheck.js";
import { installedCatalog } from "../src/models/catalog.js";
import { readModelWarnings } from "../src/models/modelWarnings.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { AssistantConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function root(): Promise<string> {
  const dir = await makeTempRoot();
  roots.push(dir);
  return dir;
}

async function writeJson(dataRoot: string, relative: string, value: unknown): Promise<void> {
  const file = path.join(dataRoot, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = Record<string, unknown>>(dataRoot: string, relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dataRoot, relative), "utf8")) as T;
}

const T = "2026-10-01T12:00:00.000Z";
const waifu = (id: string, extra: Record<string, unknown>) => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  revision: 2,
  updatedAt: T,
  id,
  name: id,
  displayName: id,
  persona: "kind",
  ...extra
});

describe("provider id table (gateway → winter)", () => {
  it("renames only the ids winter spells differently", () => {
    expect(winterProviderId("google-ai-studio")).toBe("google");
    expect(winterProviderId("qwen")).toBe("alibaba");
    for (const same of ["meta", "openrouter", "anthropic", "openai", "deepseek", "xai", "zai", "moonshot", "minimax", "mistral", "nvidia", "stepfun", "xiaomi"]) {
      expect(winterProviderId(same), same).toBe(same);
    }
  });
});

describe("model family table", () => {
  it.each([
    ["muse-spark-1.3-contributor", "muse-contributor"],
    ["claude-haiku-4-5-20251001", "haiku"],
    ["claude-haiku-5-5", "haiku"],
    ["claude-sonnet-4-6", "sonnet"],
    ["claude-sonnet-5-5", "sonnet"],
    ["deepseek-v4-flash", "deepseek-flash"],
    ["deepseek-v4.1-flash", "deepseek-flash"],
    ["deepseek-v4-flash-0915", "deepseek-flash"],
    ["deepseek-flash", "deepseek-flash"],
    ["gpt-6-luna", "luna"],
    ["gpt-5.5-luna", "luna"],
    ["gpt-6.1-sol", "sol"]
  ])("%s → %s", (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });

  it.each([
    ["muse-spark-1.3", "a non-contributor Muse Spark (contributor is an explicit choice, never implied)"],
    ["claude-opus-4-7", "Opus is not curated"],
    ["claude-fable-5", "Fable is not curated"],
    ["deepseek-v4-pro", "-pro tiers are not curated"],
    ["gpt-6-luna-pro", "-pro tiers are not curated"],
    ["gpt-5-mini", "other OpenAI families"],
    ["gemini-3.1-flash", "other vendors"],
    ["grok-4.3", "other vendors"]
  ])("%s is unmapped (%s)", (id) => {
    expect(modelFamily(id)).toBeUndefined();
  });
});

describe("mapGatewayModel", () => {
  it("maps a curated family on its own vendor's API to the direct route", () => {
    expect(mapGatewayModel("anthropic", "claude-sonnet-4-6")).toEqual(FAMILY_ROUTES.sonnet.direct);
    expect(mapGatewayModel("deepseek", "deepseek-v4-flash")).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
    expect(mapGatewayModel("openai", "gpt-6-luna")).toEqual({ providerId: "openai", modelId: "gpt-6-luna" });
    expect(mapGatewayModel("meta", "muse-spark-1.3-contributor")).toEqual({ providerId: "meta", modelId: "muse-spark-1.3-contributor" });
    // No provider stored: the family's vendor.
    expect(mapGatewayModel(undefined, "claude-haiku-4-5-20251001")).toEqual({ providerId: "anthropic", modelId: "claude-haiku-5-5" });
  });

  it("maps OpenRouter ids (vendor/model) to the OpenRouter route of the family", () => {
    expect(mapGatewayModel("openrouter", "anthropic/claude-sonnet-4.6")).toEqual({ providerId: "openrouter", modelId: "anthropic/claude-sonnet-5.5" });
    expect(mapGatewayModel("openrouter", "deepseek/deepseek-v4-flash")).toEqual({ providerId: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" });
    expect(mapGatewayModel("openrouter", "openai/gpt-6-luna")).toEqual({ providerId: "openrouter", modelId: "openai/gpt-6-luna" });
    expect(mapGatewayModel(undefined, "meta/muse-spark-1.3-contributor")).toEqual({ providerId: "openrouter", modelId: "meta/muse-spark-1.3-contributor" });
    expect(mapGatewayModel("openrouter", "anthropic/claude-opus-4.7")).toBeUndefined();
  });

  it("does not map a curated family served by another provider", () => {
    expect(mapGatewayModel("nvidia", "deepseek-v4-flash")).toBeUndefined();
    expect(mapGatewayModel("google-ai-studio", "claude-sonnet-4-6")).toBeUndefined();
  });
});

describe("effortFromParams", () => {
  it("carries a reasoning effort or reasoning.enabled:false, nothing else", () => {
    expect(effortFromParams({ "reasoning.effort": "high", temperature: 0.7 })).toBe("high");
    expect(effortFromParams({ "reasoning.effort": "xhigh" })).toBe("xhigh");
    expect(effortFromParams({ "reasoning.enabled": false })).toBe("none");
    expect(effortFromParams({ "reasoning.effort": "turbo" })).toBeUndefined();
    expect(effortFromParams({ "reasoning.enabled": true, temperature: 1 })).toBeUndefined();
    expect(effortFromParams(undefined)).toBeUndefined();
  });
});

describe("convertModelFields", () => {
  it("nests the route, drops params and the retired waifu fields", () => {
    const data: Record<string, unknown> = {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      params: { "reasoning.effort": "low", temperature: 0.3 },
      contextWindow: 50,
      personaDigest: { voice: "v", role: "r", personaHash: "h" },
      tools: { toolUse: false }
    };
    expect(convertModelFields(data, "waifu:aria", { waifu: true })).toEqual({ changed: true });
    expect(data).toEqual({ model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" } });
  });

  it("unsets an unmapped model with a warning; the assistant keeps waifu-only fields alone", () => {
    const data: Record<string, unknown> = { providerId: "openai", modelId: "gpt-5-mini", params: {}, contextWindow: 20 };
    expect(convertModelFields(data, "assistant", { waifu: false })).toEqual({
      changed: true,
      warning: { scope: "assistant", code: "model_unmapped", detail: expect.stringContaining("openai/gpt-5-mini"), previous: "openai/gpt-5-mini" }
    });
    expect(data).toEqual({ contextWindow: 20 });
  });

  it("leaves an already nested document unchanged (idempotent)", () => {
    const data: Record<string, unknown> = { model: { providerId: "deepseek", modelId: "deepseek-flash", effort: "high" } };
    expect(convertModelFields(data, "waifu:x", { waifu: true })).toEqual({ changed: false });
    expect(data).toEqual({ model: { providerId: "deepseek", modelId: "deepseek-flash", effort: "high" } });
  });

  it("keeps other tool settings when only toolUse goes", () => {
    const data: Record<string, unknown> = { tools: { toolUse: true, other: 1 } };
    convertModelFields(data, "waifu:x", { waifu: true });
    expect(data).toEqual({ tools: { other: 1 } });
  });
});

describe("living-cast-models-v1 on a data root", () => {
  async function seed(dataRoot: string): Promise<void> {
    await writeJson(dataRoot, "user/waifus/aria/waifu.json", waifu("aria", { providerId: "anthropic", modelId: "claude-sonnet-4-6", params: { "reasoning.effort": "high" }, contextWindow: 50, tools: { toolUse: true } }));
    await writeJson(dataRoot, "user/waifus/mina/waifu.json", waifu("mina", { providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash", params: { "reasoning.enabled": false } }));
    await writeJson(dataRoot, "user/waifus/opus/waifu.json", waifu("opus", { providerId: "anthropic", modelId: "claude-opus-4-7", params: { temperature: 1 } }));
    await writeJson(dataRoot, "user/waifus/muse/waifu.json", waifu("muse", { providerId: "meta", modelId: "muse-spark-1.3" }));
    await writeJson(dataRoot, "user/waifus/none/waifu.json", waifu("none", { contextWindow: 30, personaDigest: { voice: "v", role: "r", personaHash: "h" } }));
    await writeJson(dataRoot, "user/assistant/config.json", { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: T, enabled: true, providerId: "openai", modelId: "gpt-6-luna", params: { "reasoning.effort": "medium" } });
    await writeJson(dataRoot, "user/providers.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: T,
      providers: {
        "google-ai-studio": { providerId: "google-ai-studio", apiKey: "g-key", createdAt: T, updatedAt: T },
        qwen: { providerId: "qwen", apiKey: "q-old", createdAt: T, updatedAt: T },
        alibaba: { providerId: "alibaba", apiKey: "q-new", createdAt: T, updatedAt: T },
        deepseek: { providerId: "deepseek", apiKey: "d-key", createdAt: T, updatedAt: T }
      }
    });
  }

  it("converts every case, warns about the unmapped ones, and every result parses", async () => {
    const dataRoot = await root();
    await seed(dataRoot);
    expect(await migrateLivingCastModels(dataRoot)).toBe("living-cast-models-v1");

    const aria = await readJson(dataRoot, "user/waifus/aria/waifu.json");
    expect(aria.model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "high" });
    for (const retired of ["providerId", "modelId", "params", "contextWindow", "tools"]) expect(aria, retired).not.toHaveProperty(retired);
    expect((await readJson(dataRoot, "user/waifus/mina/waifu.json")).model).toEqual({ providerId: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", effort: "none" });
    expect(await readJson(dataRoot, "user/waifus/opus/waifu.json")).not.toHaveProperty("model");
    expect(await readJson(dataRoot, "user/waifus/muse/waifu.json")).not.toHaveProperty("model");
    const none = await readJson(dataRoot, "user/waifus/none/waifu.json");
    expect(none).not.toHaveProperty("personaDigest");
    expect(none).not.toHaveProperty("contextWindow");
    const assistant = await readJson(dataRoot, "user/assistant/config.json");
    expect(assistant.model).toEqual({ providerId: "openai", modelId: "gpt-6-luna", effort: "medium" });
    expect(assistant).not.toHaveProperty("params");

    for (const id of ["aria", "mina", "opus", "muse", "none"]) {
      expect(() => WaifuConfigSchema.parse(readWaifuSync(dataRoot, id)), id).not.toThrow();
    }
    expect(AssistantConfigSchema.parse(assistant).model).toEqual({ providerId: "openai", modelId: "gpt-6-luna", effort: "medium" });

    const providers = await readJson<{ providers: Record<string, { providerId: string; apiKey: string }> }>(dataRoot, "user/providers.json");
    expect(Object.keys(providers.providers).sort()).toEqual(["alibaba", "deepseek", "google"]);
    expect(providers.providers.google).toMatchObject({ providerId: "google", apiKey: "g-key" });
    // An existing key under the winter id wins over the renamed one.
    expect(providers.providers.alibaba!.apiKey).toBe("q-new");

    const warnings = await readModelWarnings(dataRoot);
    expect(warnings.map((warning) => [warning.scope, warning.code, warning.previous]).sort()).toEqual([
      ["waifu:muse", "model_unmapped", "meta/muse-spark-1.3"],
      ["waifu:opus", "model_unmapped", "anthropic/claude-opus-4-7"]
    ]);
  });

  it("archives every original document before rewriting it, and the replaced provider key (owner-private)", async () => {
    const dataRoot = await root();
    await seed(dataRoot);
    const originalOpus = await readJson(dataRoot, "user/waifus/opus/waifu.json");
    const originalAssistant = await readJson(dataRoot, "user/assistant/config.json");
    await migrateLivingCastModels(dataRoot);

    expect(modelArchivePath(dataRoot, "waifu:opus")).toBe(path.join(dataRoot, "user", ".archive", "living-cast", "models", "waifu-opus.json"));
    expect(JSON.parse(await readFile(modelArchivePath(dataRoot, "waifu:opus"), "utf8"))).toEqual(originalOpus);
    expect(JSON.parse(await readFile(modelArchivePath(dataRoot, "assistant"), "utf8"))).toEqual(originalAssistant);
    for (const id of ["aria", "mina", "muse", "none"]) {
      expect(JSON.parse(await readFile(modelArchivePath(dataRoot, `waifu:${id}`), "utf8")), id).toHaveProperty("schemaVersion");
    }

    // qwen's key lost to the existing alibaba key: archived, then removed.
    const archive = JSON.parse(await readFile(providerArchivePath(dataRoot), "utf8")) as { providers: Record<string, { apiKey: string }> };
    expect(Object.keys(archive.providers)).toEqual(["qwen"]);
    expect(archive.providers.qwen!.apiKey).toBe("q-old");
    if (process.platform !== "win32") expect((await stat(providerArchivePath(dataRoot))).mode & 0o777).toBe(0o600);
  });

  it("re-running after an interrupted run keeps the first original and does not duplicate warnings", async () => {
    const dataRoot = await root();
    await seed(dataRoot);
    const originalOpus = await readJson(dataRoot, "user/waifus/opus/waifu.json");
    await migrateLivingCastModels(dataRoot);
    // As if the run had stopped after the warning but before the rewrite: the old document is back.
    await writeJson(dataRoot, "user/waifus/opus/waifu.json", { ...originalOpus, persona: "edited later" });
    expect(await migrateLivingCastModels(dataRoot)).toBe("living-cast-models-v1");
    expect(JSON.parse(await readFile(modelArchivePath(dataRoot, "waifu:opus"), "utf8"))).toEqual(originalOpus);
    const warnings = (await readModelWarnings(dataRoot)).filter((warning) => warning.scope === "waifu:opus");
    expect(warnings).toHaveLength(1);
    expect(await readJson(dataRoot, "user/waifus/opus/waifu.json")).toMatchObject({ persona: "edited later" });
  });

  it("is idempotent: a second run changes nothing and adds no warning", async () => {
    const dataRoot = await root();
    await seed(dataRoot);
    await migrateLivingCastModels(dataRoot);
    const files = [
      "user/waifus/aria/waifu.json",
      "user/waifus/opus/waifu.json",
      "user/assistant/config.json",
      "user/providers.json",
      "app/model-warnings.json",
      "user/.archive/living-cast/models/waifu-opus.json",
      "user/.archive/living-cast/providers.json"
    ];
    const before = await Promise.all(files.map((file) => readFile(path.join(dataRoot, file), "utf8")));
    expect(await migrateLivingCastModels(dataRoot)).toBeUndefined();
    const after = await Promise.all(files.map((file) => readFile(path.join(dataRoot, file), "utf8")));
    expect(after).toEqual(before);
  });

  it("is registered once, before the every-boot effort check and the schema stamp; the gateway-0.4.0 step is gone", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    expect(ids).not.toContain("waifu-params-gateway-040-v1");
    const models = ids.indexOf("living-cast-models-v1");
    const effort = ids.indexOf("living-cast-model-effort-check");
    expect(models).toBeGreaterThan(-1);
    expect(effort).toBe(models + 1);
    expect(ids.at(-1)).toBe(`stamp-schema-version-${CURRENT_SCHEMA_VERSION}`);
    expect(MIGRATION_STEPS[models]!.frequency).toBe("once");
    expect(MIGRATION_STEPS[effort]!.frequency).toBe("every-boot");
  });

  it("runs through the real migration runner and a re-run is a no-op", async () => {
    const dataRoot = await root();
    await seed(dataRoot);
    const first = await runMigrations(dataRoot);
    expect(first.applied).toContain("living-cast-models-v1");
    const second = await runMigrations(dataRoot);
    expect(second.applied).toEqual([]);
  });

  it("the schema stamp leaves the archive verbatim", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/waifus/old/waifu.json", { ...waifu("old", { providerId: "anthropic", modelId: "claude-opus-4-7" }), schemaVersion: 1 });
    await runMigrations(dataRoot);
    expect((await readJson(dataRoot, "user/waifus/old/waifu.json")).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const archived = JSON.parse(await readFile(modelArchivePath(dataRoot, "waifu:old"), "utf8")) as Record<string, unknown>;
    expect(archived).toMatchObject({ schemaVersion: 1, providerId: "anthropic", modelId: "claude-opus-4-7" });
  });
});

function readWaifuSync(dataRoot: string, id: string): unknown {
  return JSON.parse(readFileSync(path.join(dataRoot, "user", "waifus", id, "waifu.json"), "utf8"));
}

describe("living-cast-model-effort-check (every boot)", () => {
  it("drops an effort the installed catalog does not list for the route, with a warning; listed and unknown routes stay", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/waifus/aria/waifu.json", waifu("aria", { model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "turbo" } }));
    await writeJson(dataRoot, "user/waifus/mina/waifu.json", waifu("mina", { model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" } }));
    await writeJson(dataRoot, "user/waifus/haiku/waifu.json", waifu("haiku", { model: { providerId: "anthropic", modelId: "claude-haiku-5-5", effort: "turbo" } }));
    await writeJson(dataRoot, "user/waifus/retired/waifu.json", waifu("retired", { model: { providerId: "anthropic", modelId: "claude-opus-4-7", effort: "turbo" } }));
    await writeJson(dataRoot, "user/assistant/config.json", { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: T, model: { providerId: "deepseek", modelId: "deepseek-flash", effort: "nope" } });

    expect(await checkStoredModelEfforts(dataRoot)).toBe("model-effort-check-3");
    expect((await readJson(dataRoot, "user/waifus/aria/waifu.json")).model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
    expect((await readJson(dataRoot, "user/waifus/mina/waifu.json")).model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" });
    expect((await readJson(dataRoot, "user/waifus/haiku/waifu.json")).model).toEqual({ providerId: "anthropic", modelId: "claude-haiku-5-5" });
    // Not in the installed catalog: left for the live "unavailable" warning instead.
    expect((await readJson(dataRoot, "user/waifus/retired/waifu.json")).model).toEqual({ providerId: "anthropic", modelId: "claude-opus-4-7", effort: "turbo" });
    expect((await readJson(dataRoot, "user/assistant/config.json")).model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
    expect((await readModelWarnings(dataRoot)).map((warning) => [warning.scope, warning.code]).sort()).toEqual([
      ["assistant", "effort_dropped"],
      ["waifu:aria", "effort_dropped"],
      ["waifu:haiku", "effort_dropped"]
    ]);
    // Every boot: nothing left to drop.
    expect(await checkStoredModelEfforts(dataRoot)).toBeUndefined();
  });

  it("a boot after the upgrade corrects the stale `minimal` carried onto Haiku 5.5, with a warning (review, winter 0.0.56 rows)", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/waifus/haiku/waifu.json", {
      ...waifu("haiku", { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001", params: { "reasoning.effort": "minimal" } }),
      schemaVersion: 1
    });
    await runMigrations(dataRoot);
    const haiku = await readJson(dataRoot, "user/waifus/haiku/waifu.json");
    // Mapped to the curated family, and the effort Haiku 5.5 does not list is dropped at once.
    expect(haiku.model).toEqual({ providerId: "anthropic", modelId: "claude-haiku-5-5" });
    expect(installedCatalog().models.find((model) => model.key === "anthropic/claude-haiku-5-5")?.reasoning?.efforts).not.toContain("minimal");
    expect(await readModelWarnings(dataRoot)).toEqual([
      expect.objectContaining({ scope: "waifu:haiku", code: "effort_dropped", previous: "anthropic/claude-haiku-5-5 (effort minimal)" })
    ]);
    // The resulting choice is one the write path accepts.
    expect(() => WaifuConfigSchema.parse(haiku)).not.toThrow();
  });

  it("re-validates against the catalog it is given (a winter upgrade can remove an effort)", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/waifus/aria/waifu.json", waifu("aria", { model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" } }));
    const catalog = structuredClone(installedCatalog());
    const row = catalog.models.find((model) => model.key === "anthropic/claude-sonnet-5-5")!;
    row.reasoning = { ...row.reasoning!, efforts: row.reasoning!.efforts.filter((effort) => effort !== "low") };
    expect(await checkStoredModelEfforts(dataRoot, catalog)).toBe("model-effort-check-1");
    expect((await readJson(dataRoot, "user/waifus/aria/waifu.json")).model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
  });
});
