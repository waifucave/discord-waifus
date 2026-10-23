import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import { migrateWaifuParamsGateway040 } from "../src/backend/migrationSteps/waifuParamsGateway040.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function writeJson(root: string, rel: string, value: unknown) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
const readJson = async (root: string, rel: string) => JSON.parse(await readFile(path.join(root, rel), "utf8"));

async function freshRoot() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

describe("waifu-params-gateway-040-v1", () => {
  it("is registered live (not pending), once per app version, right after configs-to-gateway-params", () => {
    const ids = MIGRATION_STEPS.map((s) => s.id);
    const step = MIGRATION_STEPS.find((s) => s.id === "waifu-params-gateway-040-v1")!;
    expect(step.pending).toBeFalsy();
    expect(step.frequency).toBe("once-per-app-version");
    expect(ids.indexOf(step.id)).toBe(ids.indexOf("configs-to-gateway-params") + 1);
  });

  it("drops params the 0.4.0 catalog rejects (temperature/topP on opus-4-7), keeps the rest, and is a no-op on re-run", async () => {
    const root = await freshRoot();
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      id: "yuki", providerId: "anthropic", modelId: "claude-opus-4-7",
      params: { temperature: 0.8, topP: 0.9, maxOutputTokens: 500, "reasoning.enabled": false }
    });
    await writeJson(root, "user/waifus/haru/waifu.json", {
      id: "haru", providerId: "anthropic", modelId: "claude-haiku-4-5-20251001",
      params: { temperature: 0.8, topP: 0.9 }
    });
    await writeJson(root, "user/orchestrator/config.json", {
      providerId: "anthropic", modelId: "claude-opus-4-7", params: { temperature: 0.2 }
    });

    const first = await migrateWaifuParamsGateway040(root);
    expect(first).toBe("waifu-params-gateway-040-3");
    const yuki = await readJson(root, "user/waifus/yuki/waifu.json");
    expect(yuki.params).toEqual({ maxOutputTokens: 500, "reasoning.enabled": false });
    expect((await readJson(root, "user/waifus/haru/waifu.json")).params).toEqual({ temperature: 0.8, topP: 0.9 });
    expect((await readJson(root, "user/orchestrator/config.json")).params).toEqual({});

    const before = await readFile(path.join(root, "user/waifus/yuki/waifu.json"), "utf8");
    expect(await migrateWaifuParamsGateway040(root)).toBeUndefined();
    expect(await readFile(path.join(root, "user/waifus/yuki/waifu.json"), "utf8")).toBe(before);
  });

  it("leaves configs without a model, with unknown models, or without params untouched", async () => {
    const root = await freshRoot();
    await writeJson(root, "user/waifus/a/waifu.json", { id: "a", params: { temperature: 1 } });
    await writeJson(root, "user/waifus/b/waifu.json", { id: "b", modelId: "no-such-model-xyz", params: { temperature: 1 } });
    await writeJson(root, "user/waifus/c/waifu.json", { id: "c", providerId: "anthropic", modelId: "claude-opus-4-7" });
    expect(await migrateWaifuParamsGateway040(root)).toBeUndefined();
    expect((await readJson(root, "user/waifus/a/waifu.json")).params).toEqual({ temperature: 1 });
    expect((await readJson(root, "user/waifus/b/waifu.json")).params).toEqual({ temperature: 1 });
  });

  it("runs from runMigrations, is recorded per app version, and re-runs on a version change", async () => {
    const root = await freshRoot();
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      id: "yuki", providerId: "anthropic", modelId: "claude-opus-4-7", params: { temperature: 0.8 }
    });
    const first = await runMigrations(root, { appVersion: "2.200.0" });
    expect(first.applied).toContain("waifu-params-gateway-040-1");
    expect((await readJson(root, "user/waifus/yuki/waifu.json")).params).toEqual({});

    // A param stored again later is only cleaned when the app version changes.
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      id: "yuki", providerId: "anthropic", modelId: "claude-opus-4-7", params: { temperature: 0.5 }
    });
    const same = await runMigrations(root, { appVersion: "2.200.0" });
    expect(same.applied.some((a) => a.startsWith("waifu-params-gateway-040"))).toBe(false);
    const upgraded = await runMigrations(root, { appVersion: "2.200.1" });
    expect(upgraded.applied).toContain("waifu-params-gateway-040-1");
  });
});
