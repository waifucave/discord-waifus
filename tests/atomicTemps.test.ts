import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recoverAtomicWriteTemps } from "../src/storage/atomic.js";

describe("recoverAtomicWriteTemps", () => {
  it("removes foreign-pid crash leftovers but never this process's in-flight temps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atomic-temps-"));
    const target = path.join(dir, "memories.json");
    const inFlight = path.join(dir, `.memories.json.${process.pid}.123.abc.tmp`);
    const foreign = path.join(dir, `.memories.json.99999999.456.def.tmp`);
    await writeFile(inFlight, "{}");
    await writeFile(foreign, "{}");

    const removed = await recoverAtomicWriteTemps(target);

    expect(removed).toEqual([foreign]);
    const remaining = await readdir(dir);
    expect(remaining).toContain(path.basename(inFlight));
    expect(remaining).not.toContain(path.basename(foreign));
  });
});
