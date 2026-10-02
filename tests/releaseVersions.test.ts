import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginReleaseVersionUpdate, prepareReleaseVersionFiles } from "../scripts/releaseVersions.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "waifus-release-version-"));
  roots.push(root);
  const originals = new Map([
    ["package.json", JSON.stringify({ name: "@waifucave/discord-waifus", version: "1.5.203", license: "MIT" }, null, 2) + "\n"],
    ["package-lock.json", JSON.stringify({ version: "1.5.203", packages: { "": { version: "1.5.203" }, "node_modules/example": { version: "2.0.0" } } }, null, 2) + "\n"],
    ["remote-compatibility.json", '{"discordWaifusVersion":"1.5.203","schemaVersion":1}\n']
  ]);
  await Promise.all([...originals].map(([name, value]) => writeFile(path.join(root, name), value)));
  return { root, originals };
}

describe("release version transaction", () => {
  it.each(["1.5.001", "v1.5.204", "1.5.204-beta", "../bad"])("rejects non-plain version %s before edits", async (version) => {
    const { root, originals } = await fixture();
    expect(() => beginReleaseVersionUpdate(root, version)).toThrow(/plain SemVer/u);
    for (const [name, value] of originals) expect(await readFile(path.join(root, name), "utf8")).toBe(value);
  });

  it("prepares the same three version changes for dry-run without changing disk", async () => {
    const { root, originals } = await fixture();
    const prepared = prepareReleaseVersionFiles(originals, "1.5.204");
    expect(JSON.parse(prepared.get("package.json")).version).toBe("1.5.204");
    const lock = JSON.parse(prepared.get("package-lock.json"));
    expect(lock.version).toBe("1.5.204");
    expect(lock.packages[""].version).toBe("1.5.204");
    expect(lock.packages["node_modules/example"].version).toBe("2.0.0");
    expect(JSON.parse(prepared.get("remote-compatibility.json")).discordWaifusVersion).toBe("1.5.204");
    for (const [name, value] of originals) expect(await readFile(path.join(root, name), "utf8")).toBe(value);
  });

  it("applies the prepared bytes and restores only its version edits after failure", async () => {
    const { root, originals } = await fixture();
    const prepared = prepareReleaseVersionFiles(originals, "1.5.204");
    const restore = beginReleaseVersionUpdate(root, "1.5.204");
    for (const [name, value] of prepared) expect(await readFile(path.join(root, name), "utf8")).toBe(value);
    restore();
    for (const [name, value] of originals) expect(await readFile(path.join(root, name), "utf8")).toBe(value);
  });

  it("does not overwrite unrelated work changed while validation runs", async () => {
    const { root } = await fixture();
    const restore = beginReleaseVersionUpdate(root, "1.5.204");
    const changed = JSON.stringify({ version: "1.5.204", license: "user-edited" }) + "\n";
    await writeFile(path.join(root, "package.json"), changed);
    expect(restore).toThrow(/non-version content changed/u);
    expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(changed);
    expect(JSON.parse(await readFile(path.join(root, "remote-compatibility.json"), "utf8")).discordWaifusVersion).toBe("1.5.204");
  });
});
