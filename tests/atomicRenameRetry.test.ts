import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, renameWithRetry } from "../src/storage/atomic.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("B25: atomic rename retries transient Windows sharing violations", () => {
  it("retries EPERM/EBUSY/EACCES on win32 until the rename succeeds", async () => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(errno("EPERM"))
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockRejectedValueOnce(errno("EACCES"))
      .mockResolvedValueOnce(undefined);
    await renameWithRetry("a.tmp", "a", { platform: "win32", rename, delaysMs: [0, 0, 0, 0] });
    expect(rename).toHaveBeenCalledTimes(4);
  });

  it("gives up after the bounded retry budget", async () => {
    const rename = vi.fn(async () => { throw errno("EBUSY"); });
    await expect(renameWithRetry("a.tmp", "a", { platform: "win32", rename, delaysMs: [0, 0] }))
      .rejects.toMatchObject({ code: "EBUSY" });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("does not retry on other platforms or for other error codes", async () => {
    const posix = vi.fn(async () => { throw errno("EPERM"); });
    await expect(renameWithRetry("a.tmp", "a", { platform: "linux", rename: posix, delaysMs: [0, 0] }))
      .rejects.toMatchObject({ code: "EPERM" });
    expect(posix).toHaveBeenCalledTimes(1);
    const other = vi.fn(async () => { throw errno("ENOENT"); });
    await expect(renameWithRetry("a.tmp", "a", { platform: "win32", rename: other, delaysMs: [0, 0] }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("removes its temp file when the final rename fails", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    // A non-empty directory at the destination makes the rename fail on every platform.
    const target = path.join(root, "record.json");
    await mkdir(path.join(target, "occupied"), { recursive: true });
    await expect(atomicWriteText(target, "{}\n")).rejects.toBeTruthy();
    const leftovers = (await readdir(root)).filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
