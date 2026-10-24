// Her notes sandbox (Living cast spec §6.7): paths that would alias the index on a case-insensitive
// disk, Windows device names and planted symbolic links are refused, so a note can never read or
// write outside `user/waifus/<id>/notes/`.
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Notes, validateNotePath } from "../src/life/notes.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function notesIn(): Promise<{ root: string; notes: Notes; dir: string }> {
  const root = await makeTempRoot();
  roots.push(root);
  const notes = new Notes(new StorageService(root), "laya");
  await notes.write("MEMORY.md", "# Memory\n");
  return { root, notes, dir: path.join(root, "user/waifus/laya/notes") };
}

describe("note paths (§6.7)", () => {
  it("accepts ordinary paths and refuses the index's other spellings and Windows device names", () => {
    for (const ok of ["MEMORY.md", "me.md", "people/kevin.md", "places/bake-club/general.md", "console.md", "com10.md"]) expect(validateNotePath(ok)).toMatchObject({ ok: true });
    for (const bad of ["memory.md", "Memory.md", "MEMORY.MD", "con.md", "nul.md", "people/aux.md", "lpt1.md", "com9/x.md", "../x.md", "/etc/passwd", "a//b.md", "a/b/c/d.md", "people/.hidden.md"]) {
      expect(validateNotePath(bad), bad).toMatchObject({ ok: false });
    }
    expect(validateNotePath("memory.md")).toEqual({ ok: false, error: "the index is MEMORY.md (upper case)" });
  });

  it("writing memory.md can never replace the index", async () => {
    const { notes } = await notesIn();
    await expect(notes.write("memory.md", "lower-case index\n")).rejects.toThrow("the index is MEMORY.md");
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n");
  });

  it("refuses a planted link to a file outside her notes, for reads, writes and deletes", async () => {
    const { root, notes, dir } = await notesIn();
    const outside = path.join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET\n");
    await symlink(outside, path.join(dir, "link.md"));
    await expect(notes.read("link.md")).rejects.toThrow("it is a link");
    await expect(notes.write("link.md", "overwrite\n")).rejects.toThrow("it is a link");
    await expect(notes.delete("link.md")).rejects.toThrow("it is a link");
    expect((await notes.list()).map((note) => note.path)).toEqual(["MEMORY.md"]);
    expect(await readFile(outside, "utf8")).toBe("SECRET\n");
  });

  it("refuses a planted folder link, so a write never lands outside", async () => {
    const { root, notes, dir } = await notesIn();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(dir, "people"));
    await expect(notes.write("people/kevin.md", "escaped write\n")).rejects.toThrow("it is a link");
    await expect(notes.read("people/kevin.md")).rejects.toThrow("it is a link");
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("refuses a notes folder that is itself a link", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(path.join(root, "user/waifus/laya"), { recursive: true });
    await symlink(elsewhere, path.join(root, "user/waifus/laya/notes"));
    const notes = new Notes(new StorageService(root), "laya");
    await expect(notes.write("me.md", "hi\n")).rejects.toThrow("it is a link");
    expect(await readdir(elsewhere)).toEqual([]);
  });
});
