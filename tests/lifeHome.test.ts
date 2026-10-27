// Her machine's host side (Living cast spec §16.2, §16.4, §16.5, §16.9): the path rules, the strict
// JSON check with line and column, a link the owner planted, Bash change sets applied all or nothing
// (a file changed under her, a crash finished at boot), /tmp expiry and its size cap, and forget by
// content hash (downloads, moved and copied files, the DM's download folder).
import { mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scrubPersonFiles } from "../src/life/forget.js";
import { checkEnvFor, homeStoreFor } from "../src/life/home/index.js";
import { HomeError } from "../src/life/home/homeStore.js";
import { herSlug, resolveHerPath } from "../src/life/home/pathRules.js";
import { parseStrictJson } from "../src/life/home/specialFiles.js";
import { updateLifeFile } from "../src/life/lifeStore.js";
import { repairLife } from "../src/life/repair.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { closeWorlds, dmOf, herFile, homeOf, KEVIN, lifeWorld, MINA_USER, ROOM_KEY, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const storeOf = async (w: LifeWorld) => homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
const host = (w: LifeWorld, relative: string) => path.join(w.root, "user/waifus/ella", ...relative.split("/"));

describe("path rules (§16.2)", () => {
  it("absolute, ~ and home-relative paths; `..` never leaves her folders; segment rules", () => {
    const ok = (input: string) => {
      const resolved = resolveHerPath(input, "ella");
      return resolved.ok ? resolved.path.virtual : resolved.error;
    };
    expect(ok("/home/ella/people/kevin.md")).toBe("/home/ella/people/kevin.md");
    expect(ok("~/people/kevin.md")).toBe("/home/ella/people/kevin.md");
    expect(ok("people/kevin.md")).toBe("/home/ella/people/kevin.md");
    expect(ok("people/../me.md")).toBe("/home/ella/me.md");
    expect(ok("/tmp/a/../b.png")).toBe("/tmp/b.png");
    expect(ok("../mina/x.md")).toBe("../mina/x.md is outside your folders (your home ~ and /tmp)");
    expect(ok("/tmp/../etc/passwd")).toBe("/tmp/../etc/passwd is outside your folders (your home ~ and /tmp)");
    expect(ok("/home/ella")).toBe("/home/ella is a folder, not a file");
    expect(resolveHerPath("~", "ella", { allowRoot: true })).toMatchObject({ ok: true, path: { root: "home", segments: [] } });
    for (const bad of ["con", "nul.txt", "COM1.md", "lpt9", "aux.json", "a\u0001b", "a\\b", "x".repeat(101)]) expect(resolveHerPath(bad, "ella").ok, bad).toBe(false);
    expect(ok("a/b/c/d/e/f/g/h/i.md")).toBe("paths can be at most 8 folders deep");
    for (const fine of ["console.md", "com10.md", ".hidden", "Ünïcode ✨.md"]) expect(resolveHerPath(fine, "ella").ok, fine).toBe(true);
    expect(herSlug({ name: "Ella" })).toBe("ella");
    expect(herSlug({ name: "Zoë Ström" })).toBe("zoe-strom");
    expect(herSlug({ name: "さくら" })).toBe("me");
  });

  it("refuses her folder when the owner made it a link, so nothing lands outside", async () => {
    const w = await lifeWorld(roots);
    const elsewhere = path.join(w.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, host(w, "home"));
    const store = await storeOf(w);
    const target = store.resolve("~/me.md");
    expect(target.ok).toBe(true);
    await expect(store.writeText(target.ok ? target.path : (undefined as never), "hi\n", checkEnvFor(w.cast.deps, "ella"))).rejects.toThrow(/link/u);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("strict JSON with line and column (§16.1 T9)", () => {
  it("names the line and column, the comma left behind and a repeated field", () => {
    const at = (text: string) => {
      try {
        parseStrictJson(text);
        return "ok";
      } catch (error) {
        const e = error as Error & { position: { line: number; column: number } };
        return `${e.position.line}:${e.position.column} ${e.message}`;
      }
    };
    expect(at('[\n  {"id": "r1"},\n]')).toMatch(/^3:1 /u);
    expect(at('[\n  {"id": "r1"},\n]')).toMatch(/comma/u);
    expect(at('[{"id": "r1" "note": "x"}]')).toMatch(/^1:14 expected "," or "\}"/u);
    expect(at('[{"id": "r1", "id": "r2"}]')).toMatch(/^1:15 .*"id"/u);
    expect(at("[{'id': 1}]")).toMatch(/^1:3 /u);
    expect(at('[{"note": "a\nb"}]')).toMatch(/^1:\d+ /u);
    expect(at('[{"note": "ok"}]')).toBe("ok");
  });
});

describe("Bash change sets (§16.3.5, §16.9)", () => {
  it("a file that changed while the command ran refuses the whole set", async () => {
    const w = await lifeWorld(roots);
    await homeOf(w).write("notes.md", "one\n");
    const store = await storeOf(w);
    const info = await stat(host(w, "home/notes.md"));
    const base = new Map([["/home/ella/notes.md", { kind: "file" as const, size: info.size, mtimeMs: info.mtimeMs }]]);
    // Someone (the app, the owner) wrote it in the meantime.
    await writeFile(host(w, "home/notes.md"), "one\ntwo\n");
    const changes = { writes: [{ path: "/home/ella/notes.md", data: Buffer.from("mine\n") }, { path: "/home/ella/other.md", data: Buffer.from("x\n") }], deletes: [], dirs: [] };
    await expect(store.applyChanges(changes, base, checkEnvFor(w.cast.deps, "ella"), { journalId: "call_1" })).rejects.toThrow("~/notes.md changed while the command ran; run it again");
    expect(await homeOf(w).read("notes.md")).toBe("one\ntwo\n");
    expect(await homeOf(w).read("other.md")).toBeUndefined();
  });

  it("a crash in the middle of a change set is finished at boot from its journal", async () => {
    const w = await lifeWorld(roots);
    await homeOf(w).write("old.md", "old\n");
    const journal = { writes: [{ path: "/home/ella/new.md", data: Buffer.from("new\n").toString("base64") }, { path: "/tmp/scratch.txt", data: Buffer.from("s").toString("base64") }], deletes: ["/home/ella/old.md"], dirs: ["/home/ella/folder"] };
    await mkdir(path.join(w.root, "user/waifus/ella/life/pending-changes"), { recursive: true });
    await writeFile(path.join(w.root, "user/waifus/ella/life/pending-changes/call_9.json"), JSON.stringify(journal));
    // A torn journal (written before anything was applied) is simply dropped.
    await writeFile(path.join(w.root, "user/waifus/ella/life/pending-changes/call_10.json"), '{"writes": [');
    await repairLife(w.cast.deps, "ella");
    expect(await homeOf(w).read("new.md")).toBe("new\n");
    expect(await homeOf(w).read("old.md")).toBeUndefined();
    expect(await herFile(w, "ella", "tmp/scratch.txt")).toBe("s");
    expect((await stat(host(w, "home/folder"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(w.root, "user/waifus/ella/life/pending-changes"))).toEqual([]);
  });

  it("the Write path and the change-set path refuse the same bad watches.json", async () => {
    const w = await lifeWorld(roots);
    const store = await storeOf(w);
    const broken = Buffer.from('[{"timeout": "2026-10-25 10:00", "note": "x", "when": []},]');
    const changes = { writes: [{ path: "/home/ella/life/watches.json", data: broken }], deletes: [], dirs: [] };
    const viaBash = await store.applyChanges(changes, new Map(), checkEnvFor(w.cast.deps, "ella"), { journalId: "c" }).catch((error: unknown) => error);
    const viaWrite = await writeHerFile(w, "life/watches.json", broken.toString()).catch((error: unknown) => error);
    expect(viaBash).toBeInstanceOf(HomeError);
    expect((viaBash as Error).message).toBe((viaWrite as Error).message);
    expect((viaBash as Error).message).toMatch(/^error: watches\.json line 1, column \d+: /u);
  });
});

describe("/tmp expiry and its size cap (§16.2, §16.9)", () => {
  it("files last written over 7 days ago are deleted with their empty folders; her home is never touched", async () => {
    const w = await lifeWorld(roots);
    await mkdir(host(w, "tmp/old"), { recursive: true });
    await writeFile(host(w, "tmp/old/a.png"), "a");
    await writeFile(host(w, "tmp/fresh.txt"), "f");
    await homeOf(w).write("ancient.md", "keep\n");
    const eightDaysAgo = new Date(w.clock.ms - 8 * 86_400_000);
    await utimes(host(w, "tmp/old/a.png"), eightDaysAgo, eightDaysAgo);
    await utimes(host(w, "home/ancient.md"), eightDaysAgo, eightDaysAgo);
    const store = await storeOf(w);
    expect(await store.expireTmp(w.clock.now(), 7)).toBe(1);
    expect(await readdir(host(w, "tmp"))).toEqual(["fresh.txt"]);
    expect(await homeOf(w).read("ancient.md")).toBe("keep\n");
    // The scheduler runs it on its first tick, then hourly.
    await utimes(host(w, "tmp/fresh.txt"), eightDaysAgo, eightDaysAgo);
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    expect(await readdir(host(w, "tmp"))).toEqual([]);
  });

  it("a download that would overfill /tmp deletes the oldest files first; one larger than /tmp is refused", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, tmp: { ...config.life.tmp, maxBytes: 1024 * 1024 } } }) });
    const store = await storeOf(w);
    const entry = { placeKey: ROOM_KEY, messageId: "1", authorId: KEVIN, downloadedAt: w.clock.now().toISOString() };
    const at = (name: string) => {
      const resolved = store.resolve(`/tmp/${name}`);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.path;
    };
    expect(await store.saveDownload(at("a.bin"), Buffer.alloc(400 * 1024, 1), { ...entry, attachmentId: "a" })).toBe(true);
    await utimes(host(w, "tmp/a.bin"), new Date(w.clock.ms - 60_000), new Date(w.clock.ms - 60_000));
    expect(await store.saveDownload(at("b.bin"), Buffer.alloc(400 * 1024, 2), { ...entry, attachmentId: "b" })).toBe(true);
    expect(await store.saveDownload(at("c.bin"), Buffer.alloc(400 * 1024, 3), { ...entry, attachmentId: "c" })).toBe(true);
    expect((await readdir(host(w, "tmp"))).sort()).toEqual(["b.bin", "c.bin"]);
    expect(await store.saveDownload(at("huge.bin"), Buffer.alloc(1024 * 1024 + 1), { ...entry, attachmentId: "h" })).toBe(false);
  });
});

describe("forget by content hash (§16.9)", () => {
  it("deletes the person's downloads and the copies she moved or made; the DM's download folder goes whole; others stay", async () => {
    const w = await lifeWorld(roots);
    const store = await storeOf(w);
    const dmKey = `dm_${KEVIN}_ella`;
    await updateLifeFile(w.storage, "ella", "handles", (file) => ({ ...file, handles: { "dm/kevin": dmKey }, primary: { [dmKey]: "dm/kevin" } }));
    const save = async (name: string, data: string, from: { placeKey: string; authorId: string }, id: string) => {
      const resolved = store.resolve(name);
      if (!resolved.ok) throw new Error(resolved.error);
      expect(await store.saveDownload(resolved.path, Buffer.from(data), { ...from, messageId: id, attachmentId: id, downloadedAt: w.clock.now().toISOString() })).toBe(true);
    };
    await save("/tmp/dm/kevin/a1-secret.txt", "kevin's secret", { placeKey: dmKey, authorId: KEVIN }, "1");
    await save("/tmp/bake-club/general/b2-cake.png", "kevin's cake photo", { placeKey: ROOM_KEY, authorId: KEVIN }, "2");
    await save("/tmp/bake-club/general/b3-mina.png", "mina's photo", { placeKey: ROOM_KEY, authorId: MINA_USER }, "3");
    // She moved one and copied another into her home; a crop of his photo is new content.
    await homeOf(w).write("photos/cake.png", "kevin's cake photo");
    await homeOf(w).write("kept/secret-copy.txt", "kevin's secret");
    await rm(host(w, "tmp/bake-club/general/b2-cake.png"));
    await homeOf(w).write("photos/cake-crop.png", "kevin's cake");
    await mkdir(host(w, "tmp/dm/kevin/notes"), { recursive: true });
    await writeFile(host(w, "tmp/dm/kevin/notes/scratch.txt"), "scratch");
    const removed = await scrubPersonFiles(w.cast.deps, await readWaifu(w.storage, "ella"), { userId: KEVIN });
    expect(removed).toBeGreaterThanOrEqual(3);
    expect(await homeOf(w).read("photos/cake.png")).toBeUndefined();
    expect(await homeOf(w).read("kept/secret-copy.txt")).toBeUndefined();
    await expect(stat(host(w, "tmp/dm/kevin"))).rejects.toMatchObject({ code: "ENOENT" });
    // Not traceable: the crop stays (the forget limits say so); Mina's photo stays.
    expect(await homeOf(w).read("photos/cake-crop.png")).toBe("kevin's cake");
    expect(await herFile(w, "ella", "tmp/bake-club/general/b3-mina.png")).toBe("mina's photo");
    const index = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/files-index.json"), "utf8")) as { entries: Array<{ authorId: string }> };
    expect(index.entries.map((entry) => entry.authorId)).toEqual([MINA_USER]);
  });

  it("/forget conversation removes only what came from the DM", async () => {
    const w = await lifeWorld(roots);
    const store = await storeOf(w);
    const dmKey = `dm_${KEVIN}_ella`;
    const save = async (name: string, data: string, placeKey: string, id: string) => {
      const resolved = store.resolve(name);
      if (!resolved.ok) throw new Error(resolved.error);
      await store.saveDownload(resolved.path, Buffer.from(data), { placeKey, authorId: KEVIN, messageId: id, attachmentId: id, downloadedAt: w.clock.now().toISOString() });
    };
    await save("/tmp/dm/kevin/a1-dm.txt", "from the dm", dmKey, "1");
    await save("/tmp/bake-club/general/b2-room.txt", "from the room", ROOM_KEY, "2");
    expect(dmOf("ella").kind).toBe("dm");
    await scrubPersonFiles(w.cast.deps, await readWaifu(w.storage, "ella"), { userId: KEVIN }, { dmOnly: true });
    expect(await herFile(w, "ella", "tmp/dm/kevin/a1-dm.txt")).toBeUndefined();
    expect(await herFile(w, "ella", "tmp/bake-club/general/b2-room.txt")).toBe("from the room");
  });

  it("a copy a running Bash saves after step 1 is found by the forget's tombstones under her life lock (review S7)", async () => {
    const w = await lifeWorld(roots);
    const store = await storeOf(w);
    const resolved = store.resolve("/tmp/dm/kevin/a1-dm.txt");
    if (!resolved.ok) throw new Error(resolved.error);
    await store.saveDownload(resolved.path, Buffer.from("from the dm"), { placeKey: `dm_${KEVIN}_ella`, authorId: KEVIN, messageId: "1", attachmentId: "1", downloadedAt: w.clock.now().toISOString() });
    const prepared = await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "owner", scope: "everything" });
    expect(prepared).toBeDefined();
    expect(await herFile(w, "ella", "tmp/dm/kevin/a1-dm.txt")).toBeUndefined();
    // Her Bash command, started before the forget, saves its copy now (the provenance is gone).
    const copy = store.resolve("~/kept.txt");
    if (!copy.ok) throw new Error(copy.error);
    await store.files.writeBytes(copy.path, Buffer.from("from the dm"));
    await w.cast.runForget(prepared!);
    expect(await herFile(w, "ella", "home/kept.txt")).toBeUndefined();
  });
});
