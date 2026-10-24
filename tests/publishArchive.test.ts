import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => { throw Error("Real archive commands are forbidden in unit tests."); }),
  spawn: vi.fn(() => { throw Error("Real publication is forbidden in unit tests."); })
}));
import { publicationInputs, publishVerifiedArchive } from "../scripts/publish-archive.mjs";
const roots: string[] = [];
const bytes = Buffer.from("immutable reviewed archive fixture");
const sha = createHash("sha256").update(bytes).digest("hex");
const identity = { name: "@waifucave/discord-waifus", version: "1.5.205" };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function input() {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-input-")); roots.push(root);
  const archive = path.join(root, "personal-checkout-name.tgz"); await writeFile(archive, bytes);
  return [archive, sha, identity.name, identity.version, "latest", "--yes"];
}

describe.skipIf(process.platform === "win32")("neutral-path immutable publication", () => {
  it("requires exact identity, reviewed digest, supported tag and explicit confirmation", async () => {
    const args = await input();
    expect(publicationInputs(args).sha256).toBe(sha);
    // The retired LLM gateway package is no longer published from this repository.
    const retiredArgs = [...args];
    retiredArgs[2] = ["@waifucave", "gateway"].join("/");
    retiredArgs[3] = "0.3.1";
    expect(() => publicationInputs(retiredArgs)).toThrow();
    for (const [index, replacement] of [[1, "bad"], [2, "@unrelated/package"], [3, "01.2.3"], [4, "arbitrary"], [5, "yes"]] as const) {
      const invalid = [...args]; invalid[index] = replacement;
      expect(() => publicationInputs(invalid)).toThrow();
    }
    expect(() => publicationInputs([...args, "--force"])).toThrow();
  });

  it("publishes identical bytes from a private neutral directory then removes only that copy", async () => {
    const args = await input(); let directory = "";
    const inspect = vi.fn(async () => ({ stdout: JSON.stringify(identity) }));
    const publish = vi.fn(async (command: string[], options: { cwd: string }) => {
      directory = options.cwd;
      expect(directory).toMatch(/^\/(?:private\/)?tmp\/waifus-publish-[^/]+$/u);
      expect(command).toEqual(["publish", "./package.tgz", "--access", "public", "--tag", "latest",
        "--registry=https://registry.npmjs.org", "--ignore-scripts", "--provenance=false"]);
      expect(JSON.stringify({ command, options })).not.toContain("personal-checkout-name");
      expect(await readFile(path.join(directory, "package.tgz"))).toEqual(bytes);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(directory, "package.tgz"))).mode & 0o777).toBe(0o600);
    });
    expect(await publishVerifiedArchive(args, { inspect, publish })).toMatchObject({ ...identity, sha256: sha, uploadAccepted: true });
    expect(publish).toHaveBeenCalledOnce();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(args[0]!)).toEqual(bytes);
  });

  it.each(["hash", "identity", "private", "path-hint", "symlink", "tamper"])("fails closed before publication for %s", async reason => {
    const args = await input();
    if (reason === "hash") args[1] = "a".repeat(64);
    if (reason === "symlink") { const target = args[0]!; args[0] = path.join(path.dirname(target), "linked.tgz"); await symlink(target, args[0]); }
    const inspect = vi.fn(async (_command: string, commandArgs: string[]) => {
      if (reason === "tamper") await writeFile(commandArgs[1]!, "changed");
      return { stdout: JSON.stringify({ ...identity,
        ...(reason === "identity" ? { name: "@unrelated/package" } : {}),
        ...(reason === "private" ? { private: true } : {}),
        ...(reason === "path-hint" ? { _resolved: "private-file-path" } : {}) }) };
    });
    const publish = vi.fn();
    await expect(publishVerifiedArchive(args, { inspect, publish })).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves the original and cleans staging on npm rejection", async () => {
    const args = await input(); let staging = "";
    await expect(publishVerifiedArchive(args, {
      inspect: async () => ({ stdout: JSON.stringify(identity) }),
      publish: async (_args: string[], options: { cwd: string }) => { staging = options.cwd; throw Error("rejected"); }
    })).rejects.toThrow("rejected");
    await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(args[0]!)).toEqual(bytes);
  });
});
