import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteDiagnosticLog } from "../src/remote/diagnosticLog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), "remote-diag-")); roots.push(result); return result; }

describe("bounded private remote diagnostics", () => {
  it("persists only closed fields and excludes private error and request data", async () => {
    const dataRoot = await root();
    const log = new RemoteDiagnosticLog({ dataRoot, role: "remote" });
    log.record({ event: "operation_failed", operation: "pair_poll", code: "helper_unavailable", message: "SECRET", url: "https://SECRET", pairId: "SECRET" } as never);
    log.record({ event: "SECRET_EVENT", operation: "SECRET_OPERATION", code: "SECRET_CODE", helperState: "SECRET_STATE" } as never);
    await log.flush();
    const raw = await readFile(log.filePath, "utf8");
    expect(raw).not.toContain("SECRET");
    const entries = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toEqual([
      { time: expect.any(String), role: "remote", event: "operation_failed", operation: "pair_poll", code: "helper_unavailable" },
      { time: expect.any(String), role: "remote", event: "other", operation: "other", code: "other", helperState: "other" }
    ]);
    if (process.platform !== "win32") {
      expect((await stat(log.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(log.filePath))).mode & 0o777).toBe(0o700);
    }
  });

  it("retains a bounded private rotated file and preserves history across writers", async () => {
    const dataRoot = await root();
    const log = new RemoteDiagnosticLog({ dataRoot, role: "host", maxBytes: 1024 });
    for (let index = 0; index < 40; index++) log.record({ event: "operation_failed", operation: index % 2 ? "runtime_start" : "runtime_stop", code: "helper_unavailable" });
    await log.flush();
    const files = await readdir(path.dirname(log.filePath));
    expect(files.sort()).toEqual(["host.jsonl", "host.jsonl.1"]);
    for (const name of files) {
      const info = await stat(path.join(path.dirname(log.filePath), name));
      expect(info.size).toBeLessThanOrEqual(1024);
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
    }
    const previous = await readFile(log.filePath, "utf8");
    const next = new RemoteDiagnosticLog({ dataRoot, role: "host", maxBytes: 1024 });
    next.record({ event: "lifecycle", helperState: "ready" });
    await next.flush();
    expect((await readFile(next.filePath, "utf8")) + (await readFile(`${next.filePath}.1`, "utf8"))).toContain(previous.trim().split("\n").at(-1));
  });

  it("coalesces repeated failures while allowing later recurrence and bounds the queue", async () => {
    let now = Date.now();
    const log = new RemoteDiagnosticLog({ dataRoot: await root(), role: "remote", now: () => now });
    for (let index = 0; index < 1000; index++) log.record({ event: "operation_failed", operation: "runtime_status", code: "helper_unavailable" });
    await log.flush();
    expect((await readFile(log.filePath, "utf8")).trim().split("\n")).toHaveLength(1);
    now += 30_001;
    log.record({ event: "operation_failed", operation: "runtime_status", code: "helper_unavailable" });
    await log.flush();
    expect((await readFile(log.filePath, "utf8")).trim().split("\n")).toHaveLength(2);
    for (let index = 0; index < 1000; index++) log.record({ event: "operation_failed", operation: index % 2 ? "runtime_start" : "runtime_stop" });
    await log.flush();
    expect((await readFile(log.filePath, "utf8")).trim().split("\n").length).toBeLessThanOrEqual(66);
  });

  it("never follows a substituted log symlink or propagates write failures", async () => {
    const dataRoot = await root();
    const log = new RemoteDiagnosticLog({ dataRoot, role: "remote" });
    log.record({ event: "lifecycle", helperState: "starting" });
    await log.flush();
    const outside = path.join(dataRoot, "preserve.txt");
    await writeFile(outside, "unchanged");
    await rm(log.filePath);
    await symlink(outside, log.filePath);
    log.record({ event: "lifecycle", helperState: "ready" });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });
});
