import { afterEach, describe, expect, it } from "vitest";
import { ModelCallError, type ModelErrorKind } from "../src/models/errors.js";
import { ProviderAlerts, ProviderCooldownError } from "../src/orchestration/providerAlerts.js";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const modelError = (kind: ModelErrorKind, message: string) => new ModelCallError(kind, message);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("ProviderAlerts", () => {
  it("opens a 10 minute quota cooldown that expires", () => {
    let now = Date.parse("2026-10-23T12:00:00.000Z");
    const alerts = new ProviderAlerts({ now: () => now });
    expect(alerts.report("openai", modelError("quota", "insufficient_quota"))).toBe(true);
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
    alerts.report("openai", modelError("quota", "q"));
    alerts.report("openai", modelError("billing", "credit balance too low"));
    expect(alerts.check("openai")?.code).toBe("provider_billing");
    expect(alerts.snapshot().map((a) => [a.kind, a.until])).toEqual([
      ["billing", "2026-10-23T12:30:00.000Z"],
      ["quota", "2026-10-23T12:10:00.000Z"]
    ]);
  });

  it("ignores other error kinds", () => {
    const alerts = new ProviderAlerts();
    expect(alerts.report("openai", modelError("rate_limit", "slow down"))).toBe(false);
    expect(alerts.report("openai", modelError("context_overflow", "too long"))).toBe(false);
    expect(alerts.report("openai", new Error("boom"))).toBe(false);
    // A fail-fast cooldown error never re-opens (or extends) the cooldown it reports.
    const cooldown = new ProviderCooldownError({ providerId: "openai", kind: "quota", until: "2026-10-23T12:10:00.000Z", lastMessage: "x" });
    expect(cooldown).toBeInstanceOf(ModelCallError);
    expect(alerts.report("openai", cooldown)).toBe(false);
    expect(alerts.snapshot()).toEqual([]);
  });
});

// Quota/billing through ModelClient (fail fast, no network, one ledger line) is covered in
// tests/modelClient.test.ts against a fake winter adapter.

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
      sharedProviderAlerts(root).report("openai", modelError("billing", "credit balance is too low"));
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
