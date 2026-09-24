import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/backend/logger.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("logger file ownership", () => {
  it("writes a role-specific explicit log file with owner-only permissions", async () => {
    const root = await makeTempRoot("waifus-role-log-");
    roots.push(root);
    const logFile = path.join(root, "app", "logs", "remote-gateway.log");
    const logger = createLogger({
      logFile,
      console: { log: () => undefined, error: () => undefined }
    });

    logger.info("remote gateway started", { role: "remote" });

    await vi.waitFor(async () => {
      expect(await readFile(logFile, "utf8")).toContain("remote gateway started");
    });
    expect((await stat(logFile)).mode & 0o077).toBe(0);
  });
});
