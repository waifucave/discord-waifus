import { afterEach, describe, expect, it } from "vitest";
import { createAppContextRuntime, resolveCompactionSettings } from "../src/orchestration/context/appRuntime.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { ServerConfig } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

describe("app context runtime", () => {
  it("applies the server compaction override per key over the app settings", () => {
    const app = { ...DEFAULT_COMPACTION_SETTINGS, maxMessages: 120 };
    expect(resolveCompactionSettings(app)).toEqual(app);
    const server = { compaction: { keepRecent: 10, enabled: false } } as unknown as ServerConfig;
    expect(resolveCompactionSettings(app, server)).toEqual({ ...app, keepRecent: 10, enabled: false });
    expect(resolveCompactionSettings(undefined, undefined)).toEqual({ ...DEFAULT_COMPACTION_SETTINGS });
  });

  it("builds a ContextRuntime over the data root", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const runtime = createAppContextRuntime({
      storage: new StorageService(root),
      discord: () => undefined,
      logger: quietLogger()
    });
    expect(runtime).toBeInstanceOf(ContextRuntime);
  });

  it("RuntimeOrchestrator constructs one and exposes it as `contexts`", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const orchestrator = new RuntimeOrchestrator({
      storage: new StorageService(root),
      discord: { fetchFreshContext: async () => [] } as never,
      logger: quietLogger()
    });
    expect(orchestrator.contexts).toBeInstanceOf(ContextRuntime);
  });
});
