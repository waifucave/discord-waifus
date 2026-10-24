// Her notes (Living cast spec §6.7, §7.1): real Markdown files under `user/waifus/<id>/notes/`, a
// small sandbox the owner can read and edit. `MEMORY.md` is the index; the rest are 1–3 path
// segments of `[a-z0-9_-]+` ending in `.md`. Limits: 16 KB per file, 200 files, 1 MB in total.
//
// Every write is atomic (temp + rename) under the `notes:<id>` lock and takes effect on disk at
// once; the system prompt's copy of MEMORY.md only refreshes at the next epoch.

import { lstat, mkdir, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../storage/atomic.js";
import type { StorageService } from "../storage/storageService.js";
import { lifeLocks, notesDir } from "./paths.js";

export const MEMORY_INDEX = "MEMORY.md";
export const MAX_NOTE_BYTES = 16 * 1024;
export const MAX_NOTE_FILES = 200;
export const MAX_NOTES_TOTAL_BYTES = 1024 * 1024;
/** The system prompt's copy of MEMORY.md is cut at 200 lines / 8 KB (§6.7). */
export const MEMORY_PROMPT_MAX_LINES = 200;
export const MEMORY_PROMPT_MAX_BYTES = 8 * 1024;
export const MEMORY_PROMPT_CUT_NOTE = "(…your index is longer than this; tidy MEMORY.md so it stays short, with links to the details.)";

/**
 * The marker a person's own note carries (`<!-- user:<id> -->`, written by the memories→notes
 * migration under the heading): the forget scrub deletes a marked file whole (§7.5 step 5).
 */
export function personMarker(userId: string): string {
  return `<!-- user:${userId} -->`;
}

/** The user ids a note's person markers name. */
export function markedUserIds(text: string): string[] {
  return [...text.matchAll(/<!--\s*user:(\d{5,25})\s*-->/gu)].map((match) => match[1]!);
}

const SEGMENT = /^[a-z0-9_-]+$/;
/** Names Windows reserves for devices (`con.md` would open the console, not a file). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** A validated note path (`MEMORY.md`, `me.md`, `people/kevin.md`), or an error message. */
export function validateNotePath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof input !== "string" || input.length === 0) return { ok: false, error: "path is required" };
  if (input === MEMORY_INDEX) return { ok: true, path: input };
  // On a case-insensitive disk `memory.md` is the index itself.
  if (input.toLowerCase() === MEMORY_INDEX.toLowerCase()) return { ok: false, error: "the index is MEMORY.md (upper case)" };
  if (input.startsWith("/")) return { ok: false, error: "paths are relative, like people/kevin.md" };
  if (input.length > 120) return { ok: false, error: "path too long" };
  const segments = input.split("/");
  if (segments.length < 1 || segments.length > 3) return { ok: false, error: "use at most 3 path segments, like people/kevin.md" };
  if (segments.some((segment) => segment.length === 0)) return { ok: false, error: "empty path segment" };
  if (segments.some((segment) => segment === "." || segment === "..")) return { ok: false, error: "\"..\" is not allowed in note paths" };
  const last = segments[segments.length - 1]!;
  if (!last.endsWith(".md") || last.length <= 3) return { ok: false, error: "note files end in .md" };
  const names = [...segments.slice(0, -1), last.slice(0, -3)];
  if (!names.every((segment) => SEGMENT.test(segment))) {
    return { ok: false, error: "use lower-case letters, digits, - and _ in note paths (and MEMORY.md for the index)" };
  }
  if (names.some((segment) => WINDOWS_DEVICE.test(segment))) return { ok: false, error: "that name is reserved on Windows; pick another" };
  return { ok: true, path: input };
}

export type NoteEntry = { path: string; bytes: number; updatedAt: string };

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export class NotesError extends Error {
  override name = "NotesError";
}

/** The notes sandbox of one waifu. */
export class Notes {
  constructor(
    private readonly storage: StorageService,
    readonly waifuId: string
  ) {}

  private dir(): string {
    return this.storage.dataPath(notesDir(this.waifuId));
  }

  private file(notePath: string): string {
    const checked = validateNotePath(notePath);
    if (!checked.ok) throw new NotesError(checked.error);
    return path.join(this.dir(), ...checked.path.split("/"));
  }

  /**
   * The note's file, refusing links: the notes folder, every folder on the way and the file itself
   * must not be symbolic links, so a planted link can never read or write outside her notes.
   */
  private async realFile(notePath: string): Promise<string> {
    const file = this.file(notePath);
    let current = this.dir();
    for (const segment of ["", ...path.relative(current, file).split(path.sep)]) {
      if (segment) current = path.join(current, segment);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) throw new NotesError(`${notePath} can't be used: it is a link`);
    }
    return file;
  }

  /** True once the notes directory exists (the memories→notes migration skips such waifus). */
  async exists(): Promise<boolean> {
    return stat(this.dir()).then((info) => info.isDirectory(), () => false);
  }

  async list(): Promise<NoteEntry[]> {
    const out: NoteEntry[] = [];
    const walk = async (dir: string, prefix: string[], depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 2) await walk(full, [...prefix, entry.name], depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const notePath = [...prefix, entry.name].join("/");
        if (!validateNotePath(notePath).ok) continue;
        const info = await stat(full).catch(() => undefined);
        if (info) out.push({ path: notePath, bytes: info.size, updatedAt: info.mtime.toISOString() });
      }
    };
    await walk(this.dir(), [], 0);
    return out.sort((a, b) => (a.path === MEMORY_INDEX ? -1 : b.path === MEMORY_INDEX ? 1 : a.path.localeCompare(b.path)));
  }

  /** The note's text, or undefined when it does not exist. */
  async read(notePath: string): Promise<string | undefined> {
    const file = await this.realFile(notePath);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Writes a note whole, enforcing the limits. Returns "created" or "updated". */
  async write(notePath: string, content: string): Promise<"created" | "updated"> {
    this.file(notePath);
    const size = bytesOf(content);
    if (size > MAX_NOTE_BYTES) throw new NotesError(`a note can be at most ${MAX_NOTE_BYTES / 1024} KB; split it into several notes`);
    return this.storage.withLocks([lifeLocks.notes(this.waifuId)], async () => {
      const file = await this.realFile(notePath);
      const notes = await this.list();
      const existing = notes.find((note) => note.path === notePath);
      if (!existing && notes.length >= MAX_NOTE_FILES) throw new NotesError(`you have ${MAX_NOTE_FILES} notes already; merge or delete some first`);
      const total = notes.reduce((sum, note) => sum + note.bytes, 0) - (existing?.bytes ?? 0) + size;
      if (total > MAX_NOTES_TOTAL_BYTES) throw new NotesError("your notes are full (1 MB); tidy or delete some first");
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Folders made just now are checked again, so a link raced in on the way is still refused.
      await this.realFile(notePath);
      await atomicWriteText(file, content);
      return existing ? "updated" : "created";
    });
  }

  /** Replaces exactly one occurrence of `find`. */
  async edit(notePath: string, find: string, replace: string): Promise<void> {
    if (find.length === 0) throw new NotesError("find must not be empty");
    const current = await this.read(notePath);
    if (current === undefined) throw new NotesError(`no note at ${notePath}`);
    const first = current.indexOf(find);
    if (first < 0) throw new NotesError("that text is not in the note; read it first");
    if (current.indexOf(find, first + find.length) >= 0) {
      let count = 0;
      for (let at = current.indexOf(find); at >= 0; at = current.indexOf(find, at + find.length)) count += 1;
      throw new NotesError(`that text appears ${count} times; include more of the surrounding text`);
    }
    await this.write(notePath, current.slice(0, first) + replace + current.slice(first + find.length));
  }

  async delete(notePath: string): Promise<boolean> {
    this.file(notePath);
    return this.storage.withLocks([lifeLocks.notes(this.waifuId)], async () => {
      const file = await this.realFile(notePath);
      const existed = await stat(file).then(() => true, () => false);
      await rm(file, { force: true });
      // Leave no empty folders behind (they would still count as nothing, but read badly).
      let dir = path.dirname(file);
      while (dir.startsWith(this.dir()) && dir !== this.dir()) {
        const removed = await rmdir(dir).then(() => true, () => false);
        if (!removed) break;
        dir = path.dirname(dir);
      }
      return existed;
    });
  }

  /** Lines matching every word of `query` (case-insensitive), as `path:line: text`, at most `limit`. */
  async search(query: string, limit = 30): Promise<Array<{ path: string; line: number; text: string }>> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const note of await this.list()) {
      const text = await this.read(note.path);
      if (text === undefined) continue;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const lower = lines[index]!.toLowerCase();
        if (words.every((word) => lower.includes(word))) {
          hits.push({ path: note.path, line: index + 1, text: lines[index]!.trim().slice(0, 200) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /** Every note's text, by path (maintenance, forget verification). */
  async readAll(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const note of await this.list()) {
      const text = await this.read(note.path);
      if (text !== undefined) out.set(note.path, text);
    }
    return out;
  }

  /** The system prompt's copy of MEMORY.md: cut at 200 lines / 8 KB with a note asking her to tidy. */
  async memoryIndexForPrompt(): Promise<string> {
    const text = (await this.read(MEMORY_INDEX)) ?? "";
    return cutMemoryIndex(text);
  }
}

export function cutMemoryIndex(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  const lines = trimmed.split("\n");
  let cut = false;
  let kept = lines;
  if (kept.length > MEMORY_PROMPT_MAX_LINES) {
    kept = kept.slice(0, MEMORY_PROMPT_MAX_LINES);
    cut = true;
  }
  let joined = kept.join("\n");
  while (bytesOf(joined) > MEMORY_PROMPT_MAX_BYTES && kept.length > 0) {
    kept = kept.slice(0, -1);
    joined = kept.join("\n");
    cut = true;
  }
  return cut ? `${joined}\n${MEMORY_PROMPT_CUT_NOTE}` : joined;
}
