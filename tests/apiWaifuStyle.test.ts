import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

// Phase 4 (spec 8.2/8.6): waifu style fields, and the removed prompt layout.

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeAppWithLogger() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const warnings: string[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => void warnings.push(message),
    error: () => undefined
  };
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    logger: logger as never
  });
  return { app, warnings };
}

describe("waifu style fields", () => {
  it("creates with defaults and round-trips verbosity/customInstructions/scheduleInPrompt", async () => {
    const { app } = await makeAppWithLogger();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "styled", name: "Styled", displayName: "Styled" }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ verbosity: "terse", customInstructions: "", scheduleInPrompt: true });

      const put = await app.inject({
        method: "PUT",
        url: "/api/waifus/styled",
        payload: { revision: 0, verbosity: "expressive", customInstructions: "Never use emoji.", scheduleInPrompt: false }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({
        verbosity: "expressive",
        customInstructions: "Never use emoji.",
        scheduleInPrompt: false
      });

      const get = await app.inject({ method: "GET", url: "/api/waifus/styled" });
      expect(get.json()).toMatchObject({
        verbosity: "expressive",
        customInstructions: "Never use emoji.",
        scheduleInPrompt: false
      });
    } finally {
      await app.close();
    }
  });

  it("a partial PUT does not reset the style fields", async () => {
    const { app } = await makeAppWithLogger();
    try {
      await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: {
          id: "keep",
          name: "Keep",
          displayName: "Keep",
          verbosity: "chatty",
          customInstructions: "Speak softly.",
          scheduleInPrompt: false
        }
      });
      const renamed = await app.inject({
        method: "PUT",
        url: "/api/waifus/keep",
        payload: { revision: 0, displayName: "Kept" }
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        displayName: "Kept",
        verbosity: "chatty",
        customInstructions: "Speak softly.",
        scheduleInPrompt: false
      });
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid verbosity and customInstructions over 4000 characters; accepts exactly 4000", async () => {
    const { app } = await makeAppWithLogger();
    try {
      await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "lim", name: "Lim", displayName: "Lim" } });
      const badVerbosity = await app.inject({
        method: "PUT",
        url: "/api/waifus/lim",
        payload: { revision: 0, verbosity: "loud" }
      });
      expect(badVerbosity.statusCode).toBe(400);
      const tooLong = await app.inject({
        method: "PUT",
        url: "/api/waifus/lim",
        payload: { revision: 0, customInstructions: "x".repeat(4001) }
      });
      expect(tooLong.statusCode).toBe(400);
      const exact = await app.inject({
        method: "PUT",
        url: "/api/waifus/lim",
        payload: { revision: 0, customInstructions: "x".repeat(4000) }
      });
      expect(exact.statusCode).toBe(200);
      expect(exact.json().customInstructions).toHaveLength(4000);
    } finally {
      await app.close();
    }
  });
});

describe("removed promptLayout in waifu bodies", () => {
  it("is accepted and ignored on POST and PUT, logged once", async () => {
    const { app, warnings } = await makeAppWithLogger();
    try {
      const staleLayout = { top: [{ kind: "block", blockId: "identity", enabled: false }], mid: [], trailing: [] };
      const created = await app.inject({
        method: "POST",
        url: "/api/waifus",
        payload: { id: "stale", name: "Stale", displayName: "Stale", promptLayout: staleLayout }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().promptLayout).not.toEqual(staleLayout);

      const put = await app.inject({
        method: "PUT",
        url: "/api/waifus/stale",
        payload: { revision: 0, displayName: "Still Stale", promptLayout: staleLayout }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().displayName).toBe("Still Stale");
      expect(put.json().promptLayout).not.toEqual(staleLayout);

      // Garbage is tolerated too: the key is ignored, not validated.
      const garbage = await app.inject({
        method: "PUT",
        url: "/api/waifus/stale",
        payload: { revision: 1, promptLayout: "nonsense" }
      });
      expect(garbage.statusCode).toBe(200);

      expect(warnings.filter((message) => message.includes("promptLayout"))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
