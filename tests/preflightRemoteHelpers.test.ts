import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => { throw new Error("External commands are forbidden in preflight path tests."); })
}));

import { createHelperPreflightRoot } from "../scripts/preflight-remote-helpers.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("helper preflight installation prefix", () => {
  it("canonicalizes a symlinked temporary root before npm receives its prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "waifus-preflight-path-test-"));
    roots.push(root);
    const physical = path.join(root, "physical");
    const alias = path.join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");

    const first = await createHelperPreflightRoot(alias);
    const second = await createHelperPreflightRoot(alias);

    expect(first).toBe(await realpath(first));
    expect(path.dirname(first)).toBe(await realpath(physical));
    expect(path.basename(first)).toMatch(/^waifus-helper-preflight-/u);
    expect(first).not.toBe(second);
    expect((await lstat(first)).isDirectory()).toBe(true);
    expect((await lstat(second)).isDirectory()).toBe(true);
  });
});
