import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ensureDataLayout } from "../src/config/layout.js";
import { CURRENT_SCHEMA_VERSION, RevisionedRecordSchema, nowIso } from "../src/shared/schemas/common.js";
import { StorageConflictError } from "../src/storage/errors.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const CounterSchema = RevisionedRecordSchema.extend({
  value: z.number().int().nonnegative()
});
type Counter = z.infer<typeof CounterSchema>;

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

function fallbackCounter(): Counter {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: nowIso(),
    value: 0
  };
}

describe("StorageService", () => {
  it("serializes concurrent writes through per-resource locks", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);

    await Promise.all(
      Array.from({ length: 25 }, async () =>
        storage.updateRevisionedJson({
          resourceKey: "counter",
          relativePath: "user/counter.json",
          schema: CounterSchema,
          fallback: fallbackCounter(),
          transform: async (current) => {
            await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
            return {
              ...current,
              value: current.value + 1
            };
          }
        })
      )
    );

    const final = await storage.readJson("user/counter.json", CounterSchema);
    expect(final.value).toBe(25);
    expect(final.revision).toBe(25);
  });

  it("rejects stale writes with the latest record", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const first = await storage.updateRevisionedJson({
      resourceKey: "counter",
      relativePath: "user/counter.json",
      schema: CounterSchema,
      fallback: fallbackCounter(),
      transform: (current) => ({ ...current, value: current.value + 1 })
    });
    await storage.updateRevisionedJson({
      resourceKey: "counter",
      relativePath: "user/counter.json",
      schema: CounterSchema,
      fallback: fallbackCounter(),
      expectedRevision: first.revision,
      transform: (current) => ({ ...current, value: current.value + 1 })
    });

    await expect(
      storage.updateRevisionedJson({
        resourceKey: "counter",
        relativePath: "user/counter.json",
        schema: CounterSchema,
        fallback: fallbackCounter(),
        expectedRevision: first.revision,
        transform: (current) => ({ ...current, value: current.value + 1 })
      })
    ).rejects.toMatchObject({
      name: "StorageConflictError",
      latest: expect.objectContaining({ value: 2 })
    } satisfies Partial<StorageConflictError<Counter>>);
  });

  it("removes interrupted atomic-write temp files before reads", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const dir = path.join(root, "user");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".counter.json.123.tmp"), "partial");

    const result = await storage.readJson("user/counter.json", CounterSchema, fallbackCounter());
    expect(result.value).toBe(0);
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
