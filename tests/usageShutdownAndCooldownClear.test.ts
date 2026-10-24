import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCallError } from "../src/models/errors.js";
import { createApiServer } from "../src/api/server.js";
import { startBackend } from "../src/backend/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { CastRuntime } from "../src/orchestration/runtime.js";
import { sharedProviderAlerts } from "../src/orchestration/providerAlerts.js";
import { sharedUsageLedger, type UsageLedger } from "../src/orchestration/usageLedger.js";
import type { UsageLedgerEntry } from "../src/shared/schemas/usage.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const quiet = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const entry = (): UsageLedgerEntry => ({
  at: new Date().toISOString(), purpose: "life", providerId: "deepseek", modelId: "deepseek-flash",
  status: "aborted", usageKnown: false, inputTokens: 0, outputTokens: 0, errorKind: "aborted", durationMs: 1
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("shutdown flushes pending usage lines", () => {
  it("CastRuntime.stop() waits for queued ledger writes", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const written: UsageLedgerEntry[] = [];
    let pending: Promise<void> = Promise.resolve();
    const slowLedger: UsageLedger = {
      record: (e) => {
        pending = pending.then(() => new Promise<void>((r) => setTimeout(() => { written.push(e); r(); }, 30)));
        return pending;
      },
      flush: () => pending
    };
    const runtime = new CastRuntime({ storage: new StorageService(root), discord: {} as never, logger: quiet(), usageLedger: slowLedger });
    void slowLedger.record(entry()); // an aborted call's line, queued fire-and-forget
    expect(written).toHaveLength(0);
    await runtime.stop();
    expect(written).toHaveLength(1);
  });

  it("startBackend().close() flushes the shared ledger before releasing the host lock", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const backend = await startBackend({ dataRoot: root, host: "127.0.0.1", port: await freePort(), mode: "test", logger: quiet() });
    // Many queued appends: close() must wait for all of them, not just the first.
    for (let i = 0; i < 300; i++) void sharedUsageLedger(root).record(entry());
    await backend.close();
    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(path.join(root, "user", "usage", `${day}.jsonl`), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(300);
    expect(JSON.parse(lines[299]!)).toMatchObject({ status: "aborted", errorKind: "aborted" });
  });
});

describe("saving provider credentials clears the provider's cooldown", () => {
  it("PUT and DELETE /api/providers/:id/credentials clear quota/billing alerts", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const runtime = createRuntimeState({
      pid: process.pid, startedAt: new Date().toISOString(), packageVersion: "1.0.0", port: 3888, dataRoot: root, mode: "test", paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const app = await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
    try {
      const alerts = sharedProviderAlerts(root);
      alerts.report("openai", new ModelCallError("quota", "q"));
      alerts.report("anthropic", new ModelCallError("billing", "b"));
      const put = await app.inject({ method: "PUT", url: "/api/providers/openai/credentials", payload: { apiKey: "sk-test-key-123456789" } });
      expect(put.statusCode).toBe(200);
      expect(alerts.snapshot().map((a) => a.providerId)).toEqual(["anthropic"]);
      expect((await app.inject({ method: "GET", url: "/api/runtime" })).json().providerAlerts).toHaveLength(1);
      const del = await app.inject({ method: "DELETE", url: "/api/providers/anthropic/credentials" });
      expect(del.statusCode).toBe(200);
      expect(alerts.snapshot()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
