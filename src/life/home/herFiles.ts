// Her two folders on the host's disk (Living cast spec §16.2): `user/waifus/<id>/home/` and
// `user/waifus/<id>/tmp/`. This layer maps checked paths (pathRules.ts) to host paths and does the
// raw reads, writes and listings, refusing links everywhere: a symbolic link (or a hard-linked
// file) the owner made is never followed, listed, read or written through. Nothing here checks
// limits or her special files; homeStore.ts does, for every writer.

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { ATOMIC_TEMP_NAME, atomicWriteFile } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import { waifuDir } from "../paths.js";
import { herPath, MAX_PATH_SEGMENTS, segmentProblem, type HerPath, type HerRoot } from "./pathRules.js";

export class HerFilesError extends Error {
  override name = "HerFilesError";
  constructor(
    message: string,
    readonly code: "missing" | "link" | "not_file" | "not_dir" | "too_large" | "invalid" = "invalid"
  ) {
    super(message);
  }
}

export type HerEntry = { path: HerPath; kind: "file" | "dir"; size: number; mtimeMs: number };

/** Data-root-relative folder of one root. */
export function rootDir(waifuId: string, root: HerRoot): string {
  return path.join(waifuDir(waifuId), root);
}

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

type Inspect = { kind: "file" | "dir" | "missing" | "link" | "other"; size: number; mtimeMs: number };

export class HerFiles {
  constructor(
    readonly storage: StorageService,
    readonly waifuId: string,
    readonly slug: string
  ) {}

  hostRoot(root: HerRoot): string {
    return this.storage.dataPath(rootDir(this.waifuId, root));
  }

  hostPath(p: Pick<HerPath, "root" | "segments">): string {
    return path.join(this.hostRoot(p.root), ...p.segments);
  }

  path(root: HerRoot, segments: readonly string[]): HerPath {
    return herPath(root, segments, this.slug);
  }

  /**
   * What is at a path, walking every component with lstat: a link anywhere on the way (the root
   * folder included) reads as `link`; a hard-linked file (more than one name) too.
   */
  async inspect(p: Pick<HerPath, "root" | "segments">): Promise<Inspect> {
    let current = this.hostRoot(p.root);
    const parts = ["", ...p.segments];
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]) current = path.join(current, parts[index]!);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (!info) return { kind: "missing", size: 0, mtimeMs: 0 };
      if (info.isSymbolicLink()) return { kind: "link", size: 0, mtimeMs: 0 };
      const last = index === parts.length - 1;
      if (!last) {
        if (!info.isDirectory()) return { kind: "missing", size: 0, mtimeMs: 0 };
        continue;
      }
      if (info.isDirectory()) return { kind: "dir", size: 0, mtimeMs: info.mtimeMs };
      if (info.isFile()) return info.nlink > 1 ? { kind: "link", size: 0, mtimeMs: 0 } : { kind: "file", size: info.size, mtimeMs: info.mtimeMs };
      return { kind: "other", size: 0, mtimeMs: 0 };
    }
    return { kind: "missing", size: 0, mtimeMs: 0 };
  }

  /** A file's bytes; refuses links, folders and files over `maxBytes`. */
  async readBytes(p: HerPath, o: { maxBytes?: number } = {}): Promise<Buffer> {
    const info = await this.inspect(p);
    if (info.kind === "missing") throw new HerFilesError(`${p.display} doesn't exist`, "missing");
    if (info.kind === "link") throw new HerFilesError(`${p.display} can't be used: it is a link`, "link");
    if (info.kind !== "file") throw new HerFilesError(`${p.display} is a folder, not a file`, "not_file");
    if (o.maxBytes !== undefined && info.size > o.maxBytes) throw new HerFilesError(`${p.display} is too large`, "too_large");
    // O_NOFOLLOW: a link swapped in after the check is still never followed.
    const handle = await open(this.hostPath(p), fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      const data = await handle.readFile();
      if (o.maxBytes !== undefined && data.length > o.maxBytes) throw new HerFilesError(`${p.display} is too large`, "too_large");
      return data;
    } finally {
      await handle.close();
    }
  }

  /** The text of a file, or undefined when it does not exist (links and folders throw). */
  async readText(p: HerPath): Promise<string | undefined> {
    try {
      return (await this.readBytes(p)).toString("utf8");
    } catch (error) {
      if (error instanceof HerFilesError && error.code === "missing") return undefined;
      throw error;
    }
  }

  /** Makes the folders on the way (refusing links and files in the way). */
  async ensureFolders(p: Pick<HerPath, "root" | "segments">, upTo: number): Promise<void> {
    await mkdir(this.hostRoot(p.root), { recursive: true, mode: 0o700 });
    for (let depth = 1; depth <= upTo; depth += 1) {
      const folder = { root: p.root, segments: p.segments.slice(0, depth) };
      const info = await this.inspect(folder);
      if (info.kind === "dir") continue;
      if (info.kind === "missing") {
        await mkdir(this.hostPath(folder), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const again = await this.inspect(folder);
        if (again.kind !== "dir") throw new HerFilesError(`${folder.segments.join("/")} can't be used: it is a link`, "link");
        continue;
      }
      if (info.kind === "link") throw new HerFilesError(`${this.path(p.root, folder.segments).display} can't be used: it is a link`, "link");
      throw new HerFilesError(`${this.path(p.root, folder.segments).display} is a file, not a folder`, "not_dir");
    }
  }

  /** Writes a file whole (folders made as needed), atomically. No checks beyond links. */
  async writeBytes(p: HerPath, data: Uint8Array): Promise<void> {
    await this.ensureFolders(p, p.segments.length - 1);
    const info = await this.inspect(p);
    if (info.kind === "link") throw new HerFilesError(`${p.display} can't be used: it is a link`, "link");
    if (info.kind === "dir") throw new HerFilesError(`${p.display} is a folder`, "not_file");
    await atomicWriteFile(this.hostPath(p), data);
  }

  /** Removes a file (or an empty-able folder tree when `recursive`). Links are refused, never followed. */
  async remove(p: HerPath, o: { recursive?: boolean } = {}): Promise<boolean> {
    const info = await this.inspect(p);
    if (info.kind === "missing") return false;
    if (info.kind === "link") throw new HerFilesError(`${p.display} can't be used: it is a link`, "link");
    if (info.kind === "dir") {
      if (!o.recursive) throw new HerFilesError(`${p.display} is a folder`, "not_file");
      // rm -r never follows a link inside (it removes the link itself).
      await rm(this.hostPath(p), { recursive: true, force: true });
      return true;
    }
    await rm(this.hostPath(p), { force: true });
    return true;
  }

  /** Removes empty folders from `p`'s parent up to (not including) the root. */
  async pruneEmptyFolders(p: HerPath): Promise<void> {
    for (let depth = p.segments.length - 1; depth >= 1; depth -= 1) {
      const folder = this.path(p.root, p.segments.slice(0, depth));
      const info = await this.inspect(folder);
      if (info.kind !== "dir") return;
      const removed = await rmdir(this.hostPath(folder)).then(() => true, () => false);
      if (!removed) return;
    }
  }

  /** One folder's entries (no links, no names the path rules refuse). */
  async list(p: HerPath): Promise<HerEntry[]> {
    const info = await this.inspect(p);
    if (info.kind === "missing") {
      if (p.segments.length === 0) return [];
      throw new HerFilesError(`${p.display} doesn't exist`, "missing");
    }
    if (info.kind === "link") throw new HerFilesError(`${p.display} can't be used: it is a link`, "link");
    if (info.kind !== "dir") throw new HerFilesError(`${p.display} is a file, not a folder`, "not_dir");
    const names = await readdir(this.hostPath(p)).catch(() => [] as string[]);
    const out: HerEntry[] = [];
    for (const name of names.sort()) {
      // A write in progress (or one a crash left) is not hers to see.
      if (segmentProblem(name) || ATOMIC_TEMP_NAME.test(name) || p.segments.length >= MAX_PATH_SEGMENTS) continue;
      const child = this.path(p.root, [...p.segments, name]);
      const childInfo = await this.inspect(child);
      if (childInfo.kind === "file" || childInfo.kind === "dir") out.push({ path: child, kind: childInfo.kind, size: childInfo.size, mtimeMs: childInfo.mtimeMs });
    }
    return out;
  }

  /** Every file and folder under a root, depth first (links and refused names skipped). */
  async walk(root: HerRoot): Promise<HerEntry[]> {
    const out: HerEntry[] = [];
    const visit = async (folder: HerPath): Promise<void> => {
      let entries: HerEntry[];
      try {
        entries = await this.list(folder);
      } catch {
        return;
      }
      for (const entry of entries) {
        out.push(entry);
        if (entry.kind === "dir") await visit(entry.path);
      }
    };
    await visit(this.path(root, []));
    return out;
  }

  /** Bytes and files under a root. */
  async usage(root: HerRoot): Promise<{ bytes: number; files: number }> {
    const entries = await this.walk(root);
    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      bytes += entry.size;
      files += 1;
    }
    return { bytes, files };
  }
}
