import { createGateway, GatewayError } from "@waifucave/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAlerts, ProviderCooldownError } from "../src/orchestration/providerAlerts.js";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { createUsageLedger } from "../src/orchestration/usageLedger.js";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import { testPrompt } from "./contextFixtures.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("ProviderAlerts", () => {
  it("opens a 10 minute quota cooldown that expires", () => {
    let now = Date.parse("2026-10-23T12:00:00.000Z");
    const alerts = new ProviderAlerts({ now: () => now });
    expect(alerts.report("openai", new GatewayError("quota", "insufficient_quota"))).toBe(true);
    expect(alerts.check("openai")?.code).toBe("provider_quota");
    expect(alerts.check("anthropic")).toBeUndefined();
    expect(alerts.snapshot()).toEqual([
      { providerId: "openai", kind: "quota", until: "2026-10-23T12:10:00.000Z", lastMessage: "insufficient_quota" }
    ]);
    now += 10 * 60_000 - 1;
    expect(alerts.check("openai")).toBeInstanceOf(ProviderCooldownError);
    now += 1;
    expect(alerts.check("openai")).toBeUndefined();
    expect(alerts.snapshot()).toEqual([]);
  });

  it("opens a 30 minute billing cooldown that outranks quota", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const alerts = new ProviderAlerts({ now: () => now });
    alerts.report("openai", new GatewayError("quota", "q"));
    alerts.report("openai", new GatewayError("billing", "credit balance too low"));
    expect(alerts.check("openai")?.code).toBe("provider_billing");
    expect(alerts.snapshot().map((a) => [a.kind, a.until])).toEqual([
      ["billing", "2026-10-23T12:30:00.000Z"],
      ["quota", "2026-10-23T12:10:00.000Z"]
    ]);
  });

  it("ignores other error kinds", () => {
    const alerts = new ProviderAlerts();
    expect(alerts.report("openai", new GatewayError("rate_limit", "slow down"))).toBe(false);
    expect(alerts.report("openai", new Error("boom"))).toBe(false);
    expect(alerts.snapshot()).toEqual([]);
  });
});

describe("quota/billing through the pipeline", () => {
  const quotaFetch = (code: string, status = 429) =>
    vi.fn(async () => new Response(JSON.stringify({ error: { code, message: `${code} reached` } }), { status }));

  it("does not retry a quota error, then fails fast without a network call until the cooldown expires", async () => {
    let now = Date.parse("2026-10-23T12:00:00.000Z");
    const fetchImpl = quotaFetch("insufficient_quota");
    const alerts = new ProviderAlerts({ now: () => now });
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek", modelId: "deepseek-v4-flash", queryRole: "waifu", providerAlerts: alerts,
      gateway: createGateway({ credentials: { deepseek: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1 })
    });
    const request = { modelId: "deepseek-v4-flash", prompt: testPrompt(), messages: [] };

    await expect(pipeline.generateWaifu(request)).rejects.toMatchObject({ kind: "quota" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // quota is not retryable

    await expect(pipeline.generateWaifu(request)).rejects.toMatchObject({ code: "provider_quota" });
    await expect(pipeline.decideReviewer!({ ...request, message: "m" })).rejects.toMatchObject({ code: "provider_quota" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // fail-fast: no network

    now += 10 * 60_000;
    await expect(pipeline.generateWaifu(request)).rejects.toMatchObject({ kind: "quota" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("opens the 30 minute billing cooldown on HTTP 402", async () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const fetchImpl = quotaFetch("payment_required", 402);
    const alerts = new ProviderAlerts({ now: () => now });
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek", modelId: "deepseek-v4-flash", queryRole: "waifu", providerAlerts: alerts,
      gateway: createGateway({ credentials: { deepseek: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch })
    });
    await expect(pipeline.generateWaifu({ modelId: "deepseek-v4-flash", prompt: testPrompt(), messages: [] })).rejects.toMatchObject({ kind: "billing" });
    expect(alerts.snapshot()).toMatchObject([{ providerId: "deepseek", kind: "billing", until: "2026-10-23T12:30:00.000Z" }]);
    await expect(pipeline.generateWaifu({ modelId: "deepseek-v4-flash", prompt: testPrompt(), messages: [] })).rejects.toMatchObject({ code: "provider_billing" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records the failed quota call in the ledger with its errorKind", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const ledger = createUsageLedger(root);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek", modelId: "deepseek-v4-flash", queryRole: "waifu", usageLedger: ledger,
      providerAlerts: new ProviderAlerts(),
      gateway: createGateway({ credentials: { deepseek: "k" }, fetchImpl: quotaFetch("insufficient_quota") as unknown as typeof fetch })
    });
    await expect(pipeline.generateWaifu({ modelId: "deepseek-v4-flash", prompt: testPrompt(), messages: [] })).rejects.toThrow();
    // a cooldown fail-fast is not a model call: still exactly one line
    await expect(pipeline.generateWaifu({ modelId: "deepseek-v4-flash", prompt: testPrompt(), messages: [] })).rejects.toThrow();
    await ledger.flush();
    const day = new Date().toISOString().slice(0, 10);
    const lines = (await readFile(path.join(root, "user", "usage", `${day}.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "failed", errorKind: "quota", usageKnown: false, purpose: "waifu_reply" });
  });
});

describe("GET /api/runtime providerAlerts", () => {
  it("exposes the active cooldowns as [{ providerId, kind, until, lastMessage }]", async () => {
    const root = await makeTempRoot("waifus-alerts-api-");
    roots.push(root);
    await ensureDataLayout(root);
    const runtime = createRuntimeState({
      pid: process.pid, startedAt: new Date().toISOString(), packageVersion: "1.0.0", port: 3888, dataRoot: root, mode: "test", paused: false,
      discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 },
      remoteAccess: {
        version: 1, enabled: false, helperState: "disabled", activationState: "activation_required", controlState: "inactive",
        directState: "inactive", trustedDeviceCount: 0, lastDirectAt: null, lastErrorCode: null
      }
    });
    const app = await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
    try {
      const empty = await app.inject({ method: "GET", url: "/api/runtime" });
      expect(empty.json().providerAlerts).toEqual([]);

      const { sharedProviderAlerts } = await import("../src/orchestration/providerAlerts.js");
      sharedProviderAlerts(root).report("openai", new GatewayError("billing", "credit balance is too low"));
      const res = await app.inject({ method: "GET", url: "/api/runtime" });
      expect(res.json().providerAlerts).toEqual([
        { providerId: "openai", kind: "billing", until: expect.any(String), lastMessage: "credit balance is too low" }
      ]);
      expect(res.json().pid).toBe(process.pid);
    } finally {
      await app.close();
    }
  });
});
