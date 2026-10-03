import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { protectNewPrivateMetadataFile } from "../src/storage/privateMetadataFile.js";
import * as privateFiles from "../src/storage/privateMetadataFile.js";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("new private metadata files", () => {
  it("can retry layout after protection fails before any metadata was written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    vi.spyOn(privateFiles, "protectNewPrivateMetadataFile").mockRejectedValueOnce(new Error("protection failed"));
    await expect(ensureRemoteOnlyLayout(root)).rejects.toThrow("protection failed");
    const file = path.join(root, "app/remote-access/installation.json");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await ensureRemoteOnlyLayout(root);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });

  it("preserves content written by another writer after a failed protection attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    vi.spyOn(privateFiles, "protectNewPrivateMetadataFile").mockImplementationOnce(async (file) => {
      await writeFile(file, "preserve this concurrent content");
      throw new Error("protection failed");
    });
    await expect(ensureRemoteOnlyLayout(root)).rejects.toThrow("protection failed");
    expect(await readFile(path.join(root, "app/remote-access/installation.json"), "utf8"))
      .toBe("preserve this concurrent content");
  });

  it("does not delete an empty replacement created by a different writer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    vi.spyOn(privateFiles, "protectNewPrivateMetadataFile").mockImplementationOnce(async (file) => {
      await rm(file);
      await writeFile(file, "", { flag: "wx" });
      throw new Error("protection failed");
    });
    await expect(ensureRemoteOnlyLayout(root)).rejects.toThrow("protection failed");
    expect(await readFile(path.join(root, "app/remote-access/installation.json"), "utf8")).toBe("");
  });

  it("protects an empty newly created file before content is written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    const file = path.join(root, "new-語-💠.json");
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    await protectNewPrivateMetadataFile(file);
    await writeFile(file, "private metadata");
    expect(await readFile(file, "utf8")).toBe("private metadata");
  });

  it("refuses to change permissions on existing content or directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    const file = path.join(root, "existing.json");
    await writeFile(file, "preserve me");
    await expect(protectNewPrivateMetadataFile(file)).rejects.toThrow("Private metadata file protection failed.");
    await expect(protectNewPrivateMetadataFile(root)).rejects.toThrow("Private metadata file protection failed.");
    expect(await readFile(file, "utf8")).toBe("preserve me");
  });

  it.skipIf(process.platform === "win32")("refuses symlinks without touching their target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-meta-"));
    roots.push(root);
    const file = path.join(root, "target");
    await writeFile(file, "");
    await symlink(file, path.join(root, "link"));
    await expect(protectNewPrivateMetadataFile(path.join(root, "link"))).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("");
  });
});
