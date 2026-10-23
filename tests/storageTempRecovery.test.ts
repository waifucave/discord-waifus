import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("I16: StorageService recovers crash temps once per file, not on every read", () => {
  it("removes foreign leftovers on the first read and skips the directory scan afterwards", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const dir = path.join(root, "user");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "thing.json"), JSON.stringify({ value: 1 }));
    const leftover = path.join(dir, ".thing.json.99999999.1.a.tmp");
    await writeFile(leftover, "{}");

    const storage = new StorageService(root);
    const schema = z.object({ value: z.number() });
    expect(await storage.readJson("user/thing.json", schema)).toEqual({ value: 1 });
    expect(existsSync(leftover)).toBe(false);

    // A later foreign temp (e.g. another process's in-flight write) is not touched by reads.
    const later = path.join(dir, ".thing.json.99999998.2.b.tmp");
    await writeFile(later, "{}");
    expect(await storage.readJson("user/thing.json", schema)).toEqual({ value: 1 });
    expect(existsSync(later)).toBe(true);

    // Recovery is tracked per file: the first read of a different file still recovers it.
    await writeFile(path.join(dir, "other.json"), JSON.stringify({ value: 2 }));
    const otherLeftover = path.join(dir, ".other.json.99999999.3.c.tmp");
    await writeFile(otherLeftover, "{}");
    expect(await new StorageService(root).readJson("user/other.json", schema)).toEqual({ value: 2 });
    expect(existsSync(otherLeftover)).toBe(false);
  });
});
