// Every route answers exactly once with the host's update-activity tracking installed (as the real
// host and remote gateway run). A stale dashboard tab after a restart reconnects to an assistant
// conversation the new process no longer has, once a second: the 404 must be a plain 404, not a
// second send that fails with ERR_HTTP_HEADERS_SENT ("Unhandled API error").
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import type { LogEntry, Logger } from "../src/backend/logger.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { UpdateActivity } from "../src/backend/updates/activity.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function recordingLogger(entries: LogEntry[]): Logger {
  const emit = (level: LogEntry["level"], message: string, context?: unknown): void => {
    entries.push({ time: new Date().toISOString(), level, message, context });
  };
  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    recent: () => [...entries]
  };
}

async function makeApp(entries: LogEntry[], activity: UpdateActivity = new UpdateActivity()) {
  const root = await makeTempRoot("waifus-reply-once-");
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    logger: recordingLogger(entries),
    updateActivity: activity
  });
  apps.push(app);
  return Object.assign(app, { root });
}

describe("one answer per request with update activity installed", () => {
  it("an unknown assistant conversation's stream is a plain 404, every time", async () => {
    const entries: LogEntry[] = [];
    const activity = new UpdateActivity();
    const app = await makeApp(entries, activity);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/api/assistant/conversations/gone-after-restart/stream" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "NotFound" });
    }
    const deleted = await app.inject({ method: "DELETE", url: "/api/assistant/conversations/gone-after-restart", headers: { "idempotency-key": Buffer.alloc(32, 0x61).toString("base64url") } });
    expect(deleted.statusCode).toBe(404);
    expect(entries.filter((entry) => entry.level === "error")).toEqual([]);
    // Every request let go of its update-activity lease.
    expect(activity.snapshot().active).toBe(0);
  });

  it("a real failure still reaches the error handler, logged with the method and route only", async () => {
    const entries: LogEntry[] = [];
    const app = await makeApp(entries);
    // The waifus folder is a file: listing it fails with ENOTDIR, an error no route maps.
    await rm(path.join(app.root, "user/waifus"), { recursive: true, force: true });
    await writeFile(path.join(app.root, "user/waifus"), "not a folder");
    const response = await app.inject({ method: "GET", url: "/api/waifus?token=s3cret" });
    expect(response.statusCode).toBe(500);
    const errors = entries.filter((entry) => entry.message === "Unhandled API error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.context).toMatchObject({ method: "GET", route: "/api/waifus" });
    expect(String((errors[0]!.context as { message?: unknown }).message)).toMatch(/ENOTDIR/u);
    expect(JSON.stringify(errors[0]!.context)).not.toContain("s3cret");
  });
});
